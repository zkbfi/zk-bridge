//! The deposit state machine. It is a pure table: the same events always give the same states.
//!
//! ```text
//! seen -> awaiting_finality -> light_client_updated -> proven -> submitted -> confirmed
//!   \________________________/                          ^           |
//!                                                         \_________/  (the withdrawal reverted, retry)
//! every state except confirmed and failed can move to confirmed (already claimed) or failed (rejected)
//! ```
//!
//! A word on names. `proven` does not mean a zero-knowledge proof exists: a withdrawal needs none. It means the
//! service built the withdrawal calldata and `verify_withdrawal` accepted it natively. The vault checks the same
//! evidence again on chain.

use crate::error::{Error, Result};

/// The state of one deposit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DepositState {
    /// Read from a finalized block of the source chain.
    Seen,
    /// The beacon source has no finalized header that covers the deposit block yet.
    AwaitingFinality,
    /// The destination light client holds a finalized header after the deposit block.
    LightClientUpdated,
    /// The withdrawal calldata exists and passed native verification.
    Proven,
    /// The withdrawal transaction was sent.
    Submitted,
    /// The deposit is paid out, by this service or by someone else.
    Confirmed,
    /// The service gave up. The reason is stored with the deposit.
    Failed,
}

/// What happened to a deposit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// The beacon source cannot cover the deposit block yet.
    BeaconNotReady,
    /// The destination light client now covers the deposit block.
    LightClientCovers,
    /// The withdrawal calldata was built and verified natively.
    WithdrawalBuilt,
    /// The withdrawal transaction was sent.
    WithdrawalSent,
    /// The withdrawal transaction was mined with success.
    WithdrawalMined,
    /// The withdrawal transaction was mined and reverted, and the deposit is not claimed. Try again.
    WithdrawalReverted,
    /// The vault reports the nonce as claimed, or reverts with `AlreadyClaimed`. This counts as success.
    AlreadyClaimed,
    /// The service gives up on the deposit.
    Rejected,
}

impl DepositState {
    /// The text stored in the database and shown in logs.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Seen => "seen",
            Self::AwaitingFinality => "awaiting_finality",
            Self::LightClientUpdated => "light_client_updated",
            Self::Proven => "proven",
            Self::Submitted => "submitted",
            Self::Confirmed => "confirmed",
            Self::Failed => "failed",
        }
    }

    /// Parses the stored text.
    ///
    /// # Errors
    /// `Error::Database` for an unknown state: a newer program wrote the file.
    pub fn parse(text: &str) -> Result<Self> {
        Ok(match text {
            "seen" => Self::Seen,
            "awaiting_finality" => Self::AwaitingFinality,
            "light_client_updated" => Self::LightClientUpdated,
            "proven" => Self::Proven,
            "submitted" => Self::Submitted,
            "confirmed" => Self::Confirmed,
            "failed" => Self::Failed,
            other => return Err(Error::Database(format!("unknown deposit state {other}"))),
        })
    }

    /// Whether no event can change the state.
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Confirmed | Self::Failed)
    }
}

/// The next state, or an error when the event is not allowed in the state.
///
/// # Errors
/// `Error::Usage` naming the state and the event.
pub fn transition(state: DepositState, event: Event) -> Result<DepositState> {
    use DepositState as S;
    use Event as E;
    let next = match (state, event) {
        (S::Confirmed | S::Failed, _) => None,
        (_, E::AlreadyClaimed) => Some(S::Confirmed),
        (_, E::Rejected) => Some(S::Failed),
        (S::Seen | S::AwaitingFinality, E::BeaconNotReady) => Some(S::AwaitingFinality),
        (S::Seen | S::AwaitingFinality, E::LightClientCovers) => Some(S::LightClientUpdated),
        (S::LightClientUpdated, E::WithdrawalBuilt) => Some(S::Proven),
        (S::Proven, E::WithdrawalSent) => Some(S::Submitted),
        (S::Submitted, E::WithdrawalMined) => Some(S::Confirmed),
        (S::Submitted, E::WithdrawalReverted) => Some(S::Proven),
        _ => None,
    };
    next.ok_or_else(|| {
        Error::Usage(format!(
            "event {event:?} is not allowed in state {}",
            state.as_str()
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use DepositState as S;
    use Event as E;

    /// Claim: the happy path walks every listed state in order.
    /// Why it matters: the order is the contract between the service, the status command and the harness.
    #[test]
    fn happy_path_visits_each_state_in_order() {
        let mut state = S::Seen;
        let mut seen = vec![state.as_str()];
        for event in [
            E::BeaconNotReady,
            E::LightClientCovers,
            E::WithdrawalBuilt,
            E::WithdrawalSent,
            E::WithdrawalMined,
        ] {
            state = transition(state, event).unwrap();
            seen.push(state.as_str());
        }
        assert_eq!(
            seen,
            [
                "seen",
                "awaiting_finality",
                "light_client_updated",
                "proven",
                "submitted",
                "confirmed"
            ]
        );
    }

    /// Claim: "already claimed" ends in `confirmed` from every live state, so it counts as success.
    /// Why it matters: another relayer, or an earlier run of this service, may have paid the deposit.
    #[test]
    fn already_claimed_confirms_from_every_live_state() {
        for state in [
            S::Seen,
            S::AwaitingFinality,
            S::LightClientUpdated,
            S::Proven,
            S::Submitted,
        ] {
            assert_eq!(
                transition(state, E::AlreadyClaimed).unwrap(),
                S::Confirmed,
                "from {state:?}"
            );
        }
    }

    /// Claim: terminal states accept no event, and a withdrawal cannot be sent before it is built.
    /// Why it matters: a confirmed deposit must never be sent twice, and an unbuilt one has nothing to send.
    #[test]
    fn terminal_states_and_skipped_steps_are_refused() {
        for event in [
            E::BeaconNotReady,
            E::LightClientCovers,
            E::WithdrawalSent,
            E::AlreadyClaimed,
            E::Rejected,
        ] {
            assert!(transition(S::Confirmed, event).is_err());
            assert!(transition(S::Failed, event).is_err());
        }
        assert!(transition(S::Seen, E::WithdrawalSent).is_err());
        assert!(transition(S::LightClientUpdated, E::WithdrawalSent).is_err());
        assert_eq!(
            transition(S::Submitted, E::WithdrawalReverted).unwrap(),
            S::Proven
        );
    }

    /// Claim: every state name parses back to itself.
    #[test]
    fn names_round_trip() {
        for state in [
            S::Seen,
            S::AwaitingFinality,
            S::LightClientUpdated,
            S::Proven,
            S::Submitted,
            S::Confirmed,
            S::Failed,
        ] {
            assert_eq!(DepositState::parse(state.as_str()).unwrap(), state);
        }
        assert!(DepositState::parse("nonsense").is_err());
    }
}
