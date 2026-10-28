# Invariants

Each invariant below is a property the code must keep. For each one the table gives where the code enforces it and which tests check it. Every test name was found by search in the tree; none is a plan. Rust test names are functions in `light-client/crates/lc-testkit/tests/<file>.rs` unless a path says otherwise. Solidity test names are functions in `test/hardened/<file>.t.sol`. Line numbers are as of the commit this file was written against; search by name if they drift.

Terms (SP1, SSZ, RLP, BLS, EIP) are explained at the top of [`README.md`](README.md).

If you can break one of these, it is a finding. If a test listed here passes while the property is false, that is a finding too: the test plan in `docs/light-client-layout/test-plan.md` Part C lists mutations (M-1 to M-47) that each must turn named tests red.

## A. Light client and the SP1 programs

### A1. The light client never stores a header that two thirds of a bound sync committee did not sign

At least 342 of 512 members sign, the aggregate signature verifies under the committee bound to the stored state, and the signing domain holds the fork version and the chain's genesis validators root.

| Enforced | Tests |
|---|---|
| `lc-core/src/update.rs` `verify_step` (participation at line 276, `verify_sync_aggregate` at 186); `bls.rs`; `BeaconLightClient.sol` `_requireStoredStart` (line 197) binds the starting committee | Rust: `update_rejections.rs` `synthetic_participation_boundary_is_342`, `synthetic_signature_and_participation_tampering`, `synthetic_other_chains_domain_is_refused`, `real_updates_reject_every_attack`; `pulsechain_real.rs` `real_pulsechain_update_does_not_verify_under_ethereums_genesis_validators_root`; `layout_fork_version.rs` `real_updates_verify_only_under_the_real_fork_version`, `in_a_mixed_fold_the_version_belongs_to_its_own_step`. Solidity: `BeaconLightClient.t.sol` `test_H01_update_revertsOnWrongPreviousCommittee`, `test_R2_09_update_revertsOnOtherGenesisValidatorsRoot`, `test_H01_update_signedUpdateDoesNotReplayOnTheOtherChain` |

### A2. Every committee that signs is named by a public value (HB-01)

A next-period signature needs the finalized header to cross into that period. The output names a next committee only when this fold proved it. `startNextSyncCommitteeHash` binds the private starting next committee. The contract writes an empty committee slot only from a proven value and never changes a stored one.

| Enforced | Tests |
|---|---|
| `update.rs` line 314 (`SignatureInNextPeriodWithoutCrossing`), `verify_fold` (line 459); `BeaconLightClient.sol` `_requireStoredStart`, `_requireNewCommittee` (line 242), `_requireNextCommitteeConsistent` (line 257) | Rust: `update_rejections.rs` `synthetic_signature_by_unbound_next_committee_needs_a_crossing`, `synthetic_next_committee_hash_is_zero_unless_this_update_proves_it`, `synthetic_next_committee_must_match_the_store`; `fold.rs` `synthetic_invented_next_committee_in_the_initial_store_is_exposed`, `synthetic_first_step_cannot_cross_without_a_known_next_committee`, `synthetic_next_committee_hash_counts_only_what_this_fold_proved`. Solidity: `BeaconLightClient.t.sol` `test_HB01_update_inventedStartingNextCommitteeIsRefusedWhenTheSlotIsEmpty`, `test_HB01_update_inventedStartingNextCommitteeIsRefusedWhenOneIsStored`, `test_HB01_update_startNextCommitteeMustMatchTheStoredSlot`, `test_H01_update_nextSlotFilledOnlyByProvenNonZeroValueAndNeverChanged`, `test_HB01_update_foldAcrossThreePeriodsMustMatchAStoredCommittee` |

### A3. Only finalized headers are stored, and the stored data comes from the finalized header

The finality branch proves the finalized root under the attested state root. Execution data in the output comes from the finalized header only; the attested header's execution data never reaches the output.

| Enforced | Tests |
|---|---|
| `update.rs` `verify_step`, `verify_finalized_execution` (line 141), `verify_attested_execution` (line 166) | Rust: `update_rejections.rs` `synthetic_every_branch_entry_matters`, `synthetic_attested_header_is_not_the_finalized_header`, `state_proofs_bind_the_attested_state_root_not_the_finalized_one`, `a_compact_attested_header_of_eight_or_nine_entries_is_checked`; `gloas.rs` `the_attested_execution_data_never_reaches_the_output`. Solidity: `BeaconLightClient.t.sol` `test_H08_update_honestPathStoresFinalizedBlock`, `test_H08_update_revertsWhenPublicValuesDifferFromProvenValues` |

### A4. The head only moves forward and never past the current slot

| Enforced | Tests |
|---|---|
| `BeaconLightClient.sol` `_requireProgress` (line 222: `HeadNotAdvancing`, `HeadInFuture`, empty roots) | `BeaconLightClient.t.sol` `test_H08_update_revertsWhenHeadDoesNotAdvance`, `test_H08_update_replayedOutputIsRejected`, `test_G04_update_refusesAHeadOneSlotAfterTheCurrentSlotAndAcceptsTheCurrentSlot`, `test_G04_update_beforeGenesisEveryHeadIsInTheFuture`, `test_H08_update_pastHeadsStayStored`; `HardenedFuzz.t.sol` `testFuzz_HB01_updateAcceptsExactlyTheAdvancingSlots` |

### A5. The layout comes from the evidence, and all branches of a step agree on one shape

The finality branch length names the layout (6, 7, 8 or 9 entries: plain depth 5, 6, 7 or Gloas). Every other length is refused. The next committee branch and the genesis validators root branch must have that layout's length. Branch checks are exact: no leading zero is stripped or accepted.

| Enforced | Tests |
|---|---|
| `lc-core/src/layout.rs` `ALLOWED_FINALITY_BRANCH_LENGTHS` (line 494), `state_layout_for_finality_branch_length` (line 503); `ssz.rs` `is_valid_exact_branch` (line 147) | Rust: `layout_state_depth.rs` `every_other_finality_branch_length_is_refused`, `finality_branch_length_eight_names_plain_depth_seven`, `mixed_branch_lengths_in_one_step_are_refused`, `an_honest_committee_branch_at_another_depth_is_refused_in_one_step`, `a_gloas_finality_branch_with_a_plain_committee_branch_is_refused`, `real_ethereum_cut_and_padded_finality_branches_are_refused`, `real_pulsechain_zero_padded_finality_branch_is_refused`, `real_sepolia_gloas_cut_and_padded_finality_branches_are_refused`, `synthetic_true_depth_five_state_refuses_the_claimed_electra_and_gloas_layouts`, `synthetic_true_depth_six_state_refuses_the_claimed_capella_and_gloas_layouts`; `lc-core/src/layout.rs` inline `the_finality_branch_length_names_the_layout` |

### A6. The genesis validators root branch pins the shape in every step of both programs

`genesis_validators_root` (state field 1) is proven at the claimed layout under the attested state root. The leaf comes from the compiled chain constants, never from the input. Steps without a next committee and the fold steps of the observation program check it too.

| Enforced | Tests |
|---|---|
| `update.rs` `verify_step` (line 358, `InvalidGenesisValidatorsRootBranch`); `observation.rs` | `layout_genesis_validators_root.rs` `a_wrong_layout_claim_fails_on_the_genesis_validators_root`, `the_genesis_validators_root_leaf_comes_from_the_chain_specification`, `the_genesis_validators_root_position_follows_the_finality_layout_not_the_branch_length`, `the_genesis_validators_root_is_checked_against_the_attested_state_root`, `a_step_without_a_next_committee_still_needs_the_genesis_validators_root`, `every_step_of_a_mixed_fold_checks_its_own_genesis_validators_root`, `the_observation_fold_checks_the_genesis_validators_root`, `every_wrong_genesis_validators_root_position_lands_on_a_node_that_cannot_equal_the_root`, `the_real_genesis_validators_root_branches_verify_against_the_real_states`; `layout_state_depth.rs` `wide_state_forgery_at_field_41_fails_the_genesis_validators_root_and_the_honest_depth_seven_update_verifies`, `gloas_claims_on_a_true_depth_seven_state_fail_the_genesis_validators_root`, `a_zero_padded_genesis_validators_root_branch_is_refused` |

### A7. The execution block hash and number are bound by hash

A full header proves the payload root at index 25. A compact header names its anchor by branch length (412, 812 or the Gloas state anchor 2947). For a finalized compact header, keccak256 of the attached RLP must equal the proven block hash, and the block number is item 8 of that RLP.

| Enforced | Tests |
|---|---|
| `update.rs` `verify_execution_branch` (line 107), `verify_finalized_execution` (keccak check at line 151); `layout.rs` `compact_anchor_for_branch_length` (line 622); `execution.rs` | `layout_execution.rs` `only_three_branch_lengths_name_an_anchor`, `a_branch_of_a_length_that_names_no_anchor_is_refused`, `index_412_on_a_deneb_payload_is_caught_only_by_keccak`, `index_2947_on_a_depth_five_state_is_caught_only_by_keccak`, `index_812_on_a_capella_payload_lands_below_block_number`, `a_wrong_payload_form_named_by_the_prover_fails`, `the_real_length_eleven_anchor_verifies_and_needs_the_right_rlp`; `gloas.rs` `a_wrong_execution_header_rlp_is_refused`, `a_gloas_fold_reports_the_block_number_of_the_rlp` |

### A8. Public values keep their size and the two programs cannot be swapped

The light-client output is exactly 352 bytes (11 words). The fork observation output is exactly 256 bytes (8 words). The two programs have different keys, and the registry refuses a registry key equal to the light-client key.

| Enforced | Tests |
|---|---|
| `BeaconLightClient.sol` `PUBLIC_VALUES_LENGTH = 352`; `ForkRegistry.sol` `PUBLIC_VALUES_LENGTH = 256` and constructor (`ObservationKeyEqualsLightClientKey`); `lc-core/src/abi.rs` | Solidity: `BeaconLightClient.t.sol` `test_H04_update_publicValuesLengthIsExactly352`, `test_H04_update_revertsOnWrongLength`, `test_H04_update_revertsOnProofOfAnotherProgram`; `ForkRegistry.t.sol` `test_HB02_registry_publicValuesMustBeExactly256Bytes`, `test_HB02_registry_theTwoProofKindsCannotBeSwapped`, `test_HB02_registry_constructorRefusesEqualKeysAndZeroValues`. Rust: `fork_observation.rs` `observation_output_and_light_client_output_have_different_lengths`; `layout_real_accepts.rs` `real_data_keeps_the_public_values_byte_for_byte` (golden bytes in `golden_public_values.txt`) |

### A9. The guest input decoder is bounded and exact

A fold has 1 to 64 steps. Branch counts are limited. Truncated input and trailing bytes are refused.

| Enforced | Tests |
|---|---|
| `lc-core/src/wire.rs` | `fold.rs` `synthetic_fold_length_is_one_to_sixty_four`, `synthetic_guest_entry_point_runs_a_fold`; `fork_observation.rs` `observation_decoder_limits_steps_to_64`, `observation_guest_entry_point_and_wire_format`; `fork_observation_depth.rs` `the_wide_wire_limits_apply_to_the_observation_branches_only`; `layout_genesis_validators_root.rs` `the_wire_format_carries_the_genesis_validators_root_branch`; `update_rejections.rs` `real_updates_run_through_the_guest_entry_point` |

### A10. The deployed program keys come from the published source

| Enforced | Tests |
|---|---|
| `light-client/scripts/program-keys.sh` (Docker build in a pinned image, compared with `light-client/program-keys.json`); `script/hardened/DeployBridge.s.sol` reads the keys from the configuration | `light-client/scripts/test-program-keys.sh` (the skip and force paths of the script). A real rebuild is `program-keys.sh --force`; it is manual, not a test |

## B. Fork observation and the fork gate

### B1. A fork observation proves the version and the shape of the state that a bound committee signed

At least 342 signers of the bound committee, a signature after the final head, the observed version proven at `fork.current_version`, and the genesis validators root at the same shape. Plain depths 8 to 31 can be proven, so a disallowed shape can be recorded.

| Enforced | Tests |
|---|---|
| `lc-core/src/observation.rs` `verify_fork_observation` (`InvalidForkShapeProof`) | `fork_observation.rs` `observation_with_341_signers_is_rejected`, `observation_signed_by_an_unbound_committee_is_rejected`, `observation_signature_at_or_before_the_final_head_is_rejected`, `observation_in_the_next_period_without_a_crossing_is_rejected`, `observation_under_the_other_chains_genesis_validators_root_is_rejected`, `observation_naming_a_version_the_committee_did_not_sign_is_rejected`, `observation_forged_attested_slot_is_rejected`, `real_pulsechain_aggregate_proves_version_0x0000036c_and_not_0x0000036d`; `fork_observation_depth.rs` `a_store_that_folded_before_the_fork_observes_a_depth_eight_state`, `no_deeper_candidate_confirms_a_state_of_an_allowed_shape`; `layout_genesis_validators_root.rs` `the_fork_observation_reports_the_shape_of_its_state` |

### B2. The registry accepts only observations that start at the light client's stored state and are fresh

| Enforced | Tests |
|---|---|
| `ForkRegistry.sol` `observe` (line 105), `_requireStoredStart` (line 137, `ObservationNotFresh` and the start fields) | `ForkRegistry.t.sol` `test_HB02_registry_everyStartFieldMustMatchTheLightClient`, `test_HB02_registry_zeroNextCommitteeMeansZero`, `test_HB02_registry_freshnessNeedsASlotPastTheHead`, `test_HB02_registry_anObservationDoesNotSurviveAHeadUpdate`, `test_HB02_registry_firstSeenSlotKeepsTheMinimum`, `test_HB02_registry_agreesWithTheProgramFixtures` |

### B3. The gate never confirms a shape that the program cannot read

The gate's allowed shapes equal the program's: plain depth 5, 6, 7 and Gloas. A confirmation needs `fork.current_version` and `genesis_validators_root` proven at the same allowed shape under a beacon root of the current epoch. A proof of `previous_version` neither confirms nor seals.

| Enforced | Tests |
|---|---|
| `ForkShape.sol` `judge` (line 121), `isAllowed`; `BeaconForkGate.sol` `confirm` (line 280), `admit` (line 262), shape refusal at line 527 | `BeaconForkGate.t.sol` `test_HB02_forkShape_gateShapesEqualTheLightClientProgramAllowedSet` (compares with `program` in `light-client/tests/fixtures/gindices.json`), `test_HB02_forkShape_positionsEqualTheLightClientLayout`, `test_HB02_forkShape_everyNameConfirmsAtAnAllowedShapeAndNoneAtADisallowedOne`, `test_HB02_depth_confirmAndSealRefuseEveryWrongPair`, `test_HB02_previousVersionProofNeitherConfirmsNorSeals`, `test_HB02_confirmation_coversOnlyItsEpoch`, `test_HB02_confirmation_headerEpochRules`, `test_HB02_revert_headerRootMismatch`; `BeaconForkGateGenesisRoot.t.sol` `test_HB02_genesisRoot_confirmRequiresTheGenesisValidatorsRootAtTheClaimedShape`, `test_HB02_genesisRoot_aForeignRootIsRefusedAtEveryShape`, `test_HB02_genesisRoot_mustSitAtTheShapeThatTheVersionProved`, `test_HB02_genesisRoot_theBranchLengthIsExact`; `GloasGate.t.sol` `test_realGloasEvidenceConfirms`, `test_realGloasEvidenceNeedsTheRealGenesisBranch` |

### B4. A seal needs a proof of a disallowed shape, is permanent, and cannot use old evidence

A seal needs a valid proof at plain depth 8 to 31 (or, in registry mode, a recorded disallowed shape). An allowed shape never seals. The header must be at least as new as the deployment slot and the newest confirmation. The Solidity seal bounds equal the Rust bounds.

| Enforced | Tests |
|---|---|
| `BeaconForkGate.sol` `seal` (line 299; `SealEvidenceTooOld` at 310; `ShapeIsAllowed` at 535; registry path at 441 to 448); `ForkShape.sol` `MIN_SEAL_DEPTH`, `MAX_SEAL_DEPTH` | `BeaconForkGate.t.sol` `test_HB02_seal_refusesEveryAllowedShape`, `test_HB02_seal_acceptsAValidProofOfADisallowedShape`, `test_HB02_seal_worksAtEveryDisallowedDepth`, `test_HB02_depth_sealLengthsOutsideTheRangeRefused`, `test_HB02_seal_closesTheGateForGood`, `test_HB02_seal_headerBeforeDeploymentRefused`, `test_HB02_seal_headerOlderThanLastConfirmationRefused`, `test_HB02_bridge_sendAfterSealReverts`, `test_HB02_bridge_deliveryStillWorksAfterSeal`; `ForkRegistry.t.sol` `test_HB02_registryGate_aDisallowedObservedShapeRefusesSendsAndAllowsSeal`, `test_HB02_registryGate_aRealDepthEightObservationRefusesDepositsAndSeals`, `test_HB02_registryGate_anAllowedObservedShapeChangesNothing`; Rust inline test `the_depth_bounds_equal_the_solidity_seal_bounds` in `lc-core/src/observation.rs` |

### B5. Detection mode switches to enforcing once and for good, and never on spoofed data

| Enforced | Tests |
|---|---|
| `BeaconForkGate.sol` `admit` (probe and canaries) | `BeaconForkGate.t.sol` `test_HB02_detection_admitsWithNoCodeAtTheAddress`, `test_HB02_detection_genuineCodeWithEmptyStorageIsAbsent`, `test_HB02_detection_malformedAnswersAreAbsent`, `test_HB02_detection_switchesToEnforcingForGood`, `test_HB02_detection_staysEnforcingWhenTheRootDisappears`, `test_HB02_enforcing_appliesFromDeploymentEvenWithNoCode`; `BeaconForkGateCanaries.t.sol` `test_HB02_canary_everyCanaryFailsOnShanghaiAndDepositsAreAdmitted`, `test_HB02_canary_eachOpcodeCanaryFiresAloneAndTheGateEnforces`, `test_HB02_canary_switchIsForGood`, `test_HB02_canary_aProbeThatBurnsAllGasCostsNoMoreThanItsCap`; `Bytecode.t.sol` `test_HB02_canaryOpcodesLiveOnlyInTheProbe` |

## C. Message bridge

### C1. A message is delivered at most once

| Enforced | Tests |
|---|---|
| `MessageBridge.sol` `executeMessage` (line 292, `AlreadyDelivered`; line 283, `MessageInProgress`) | `MessageBridgeDelivery.t.sol` `test_replay_secondExecutionRefused`, `test_context_nestedExecutionIsRefused`; `invariant/RealBridgeInvariant.t.sol` `invariant_aMessageExecutesAtMostOnce`, `invariant_refusedAttemptsChangeNothing`, `invariant_sentIdentifiersAreUnique`; `HardenedFuzz.t.sol` `testFuzz_H12_noncesAreUnique` |

### C2. A delivered message was emitted by the remote bridge in a finalized block of the source chain, for this chain

The anchor is a header the light client stored. Ancestry goes through `block_roots` (distance up to 8192 slots) or `historical_summaries` (beyond), chosen by the bridge from the two slots, with exact branch lengths. Then the block hash, the execution header, the receipt and transaction tries at the same index, receipt status 1, the log index, the emitter, topic 0, the source chain and the destination chain.

| Enforced | Tests |
|---|---|
| `BeaconProofVerifier.sol` (anchor at line 697, receipt status at 458, emitter at 476); `MessageBridge.sol` (index check at 285, chain checks at 360 to 362, topic at 339) | `MessageBridgeProof.t.sol` `test_log_wrongEmitterIsRefused`, `test_log_wrongDestinationChainIsRefused`, `test_log_wrongSourceChainIsRefused`, `test_log_wrongTopicIsRefused`, `test_log_failedReceiptIsRefused`, `test_log_identifierOfTheTopicMustMatchTheMessage`, `test_receipt_tamperedProofIsRefused`, `test_transaction_tamperedBranchIsRefused`, `test_transaction_mismatchedIndicesAreRefused`, `test_anchor_unstoredAnchorIsRefused`, `test_anchor_sourceNotBeforeTheAnchorIsRefused`, `test_anchor_tamperedBranchesAreRefused`; `MessageBridgeGaps.t.sol` `test_anchor_headerAtAnUnstoredSlotIsRefused`, `test_anchor_everyForgedFieldIsRefused`, `test_ancestry_branchOfTheWrongLengthIsRefused`; `HistoricalAncestry.t.sol` `test_HB01_edge_distance8192IsRecentAnd8193IsHistorical`, `test_HB01_edge_recentBranchAtDistance8193Refused`, `test_HB01_edge_historicalBranchAtDistance8192Refused`, `test_HB01_branchTamper_everyLevelRejected`, `test_HB01_era_depositBeforeCapellaEraRejected`; `MessageBridgeShapes.t.sol` `test_receiptType_zeroToFourAreDelivered`, `test_twoMessages_inOneReceiptAreBothDelivered`, `test_branches_receiptBranchOfAnotherIndexIsRefused`; `HardenedFuzz.t.sol` `testFuzz_H08_withdrawRejectsAnyFlippedBit`, `testFuzz_R2_06_withdrawRejectsOtherIndices` |

### C3. The Rust reference and the bridge agree on every message case

| Enforced | Tests |
|---|---|
| `lc-core/src/message.rs` `verify_message` mirrors `executeMessage`; 91 fixtures in `light-client/tests/fixtures/message/` | `LightClientFixtures.t.sol` `test_R2_04_rustFixturesAgreeWithSolidityBridge`, `test_R2_04_layoutSlotsAreThoseOfTheBridge`; Rust `fixtures_agree.rs` `every_fixture_gives_its_declared_outcome`, `fixture_files_on_disk_are_current`, `gindices_equal_hand_computed_values` |

### C4. A layout row names only its field's own position, and ranges of different positions never overlap (HB-03, HB-04)

`block_roots` at `2^d + 5`, `historical_summaries` at `2^d + 27` (d in 5, 6, 7), `block_hash` at `(2^db + 9) * 2^dp + 12`, plus the fixed Gloas positions. A row grows only from stored data. A slot inside another position's range is refused. Block hash rows are refused at and after the Gloas fork slot.

| Enforced | Tests |
|---|---|
| `BeaconProofVerifier.sol` `addBlockRootsLayout` (line 487), `addBlockHashLayout` (line 523), `addHistoricalSummariesLayout`; `LayoutRangeConflict` at line 617; `GloasSlotRefused` at line 690; `lc-core/src/layout.rs` `is_block_roots_position` and neighbours (line 636 on) | `ForkLayout.t.sol` `test_defect1_eth1DataVotesPositionRefusedAsBlockRoots`, `test_defect1_blockRootsPositionRuleIsExact`, `test_defect2_graffitiAndEth1DataPositionsRefusedAsBlockHash`, `test_defect2_blockHashPositionRuleIsExact`, `test_H19_blockRootsLayoutAtFinalizedCheckpointRejected`, `test_HB01_historicalLayoutAtLatestBlockHeaderRejected`; `DeepLayoutPositions.t.sol` `test_HB03_deepBlockRoots133_evidenceOfTodaysLayoutsRefused`, `test_HB04_deepBlockHash668_evidenceOfTodaysLayoutsRefused`; `LayoutRangeRule.t.sol` `testFuzz_rangeRule_rangesOfDifferentPositionsNeverOverlap`, `test_rangeRule_slotInsideAnotherRangeRefused`; `GloasGuard.t.sol` `test_blockHashLayoutIsRefusedForAGloasHead`; `GloasPositions.t.sol` `test_neighboursAndTheOtherFieldAreRefused`; Rust inline `position_rule_matches_the_bridge` in `lc-core/src/layout.rs` |

### C5. A Gloas message source is proven by a later block's bid parent hash, never by a bid's own block hash

| Enforced | Tests |
|---|---|
| `BeaconProofVerifier.sol` Gloas source path (body index 2856, keccak of the header RLP) | `GloasSource.t.sol` `test_bidParentBlockHashProvesTheMessageBlock`, `test_bidBlockHashIsRefused`, `test_wrongPositionIsRefused`, `test_rlpMismatchIsRefused`, `test_sourceThatIsNotAnAncestorIsRefused`, `test_realSepoliaProofReachesTheLogChecks` |

### C6. An executor cannot burn a message by giving too little gas

The bridge refuses to execute unless it can forward the full message gas after the 63/64 rule plus its bookkeeping. The message stays undelivered when refused. A target that runs out of its own gas is a final failure.

| Enforced | Tests |
|---|---|
| `MessageBridge.sol` line 382 (`InsufficientGas`) | `MessageBridgeDelivery.t.sol` `test_gasGuard_starvedExecutionIsRefusedAndTheMessageSurvives`, `test_gasGuard_leastGasGivesTheTargetAllItsGasAndFinishesTheBookkeeping`, `test_final_targetThatBurnsItsGasIsAFinalFailure`, `test_final_revertingTargetIsDeliveredAsAFailure` |

### C7. The delivery context is set only during the call to the target

| Enforced | Tests |
|---|---|
| `MessageBridge.sol` `executeMessage` | `MessageBridgeDelivery.t.sol` `test_deliver_contextShowsTheProvenValuesDuringTheCall`, `test_deliver_contextIsClearedAfterTheCall`, `test_context_aTargetMaySendDuringItsDelivery` |

### C8. Sends are refused until the bridge is opened, and the lock opens once and never closes

`openDeposits` needs a proof that the remote light client stored an update in a block of the other chain that this chain's light client stored. A send checks, in this order: the lock, the cutoff, the gas range, the forbidden selectors, the gate.

| Enforced | Tests |
|---|---|
| `MessageBridge.sol` line 238 (`DepositsNotOpen`), `openDeposits` (line 413); `BeaconProofVerifier.sol` opening proof | `MessageBridgeSend.t.sol` `test_lock_closedBridgeRefusesEverySendFirst`, `test_lock_honestProofOpensTheBridgeForGood`, `test_send_forbiddenSelectorsAreRefused`, `test_gate_refusalStopsTheSendAndSpendsNoNonce`; `MessageBridgeGaps.t.sol` `test_sendOrder_lockCutoffGasSelectorThenGate`; `DepositOpening.t.sol` `test_open_opensExactlyWhenTheRemoteLightClientStoredAnUpdate`, `test_open_refusesAnUnstoredRemoteSlot`, `test_open_refusesAnotherAccount`, `test_open_refusesAnEmptyEntry`, `test_open_neverClosesAgain`, `test_pin_executionBlockHashesLivesAtDeclaredSlotThree` |

## D. Token mediator and bridged tokens

### D1. The mediator's record of a native token never exceeds what it holds

For each native token: balance = record + failed releases + plain transfers. For tokens that charge nothing on transfer, the tests tighten this to equality with the known surplus.

| Enforced | Tests |
|---|---|
| `TokenMediator.sol` relay paths (received-amount accounting, `_acceptTransfer` at line 436) and `_receive` (line 645), which lowers the record on every release, paid or failed | `mediator/TokenMediatorInvariant.t.sol` `invariant_theHomeBalanceIsTheRecordPlusStuckPlusDonations`; `invariant/MediatorRouterInvariant.t.sol` `invariant_theMediatorHoldsTheRecordExactly`; `invariant/RealBridgeInvariant.t.sol` `invariant_custodyIdentity`; `mediator/TokenMediator.t.sol` `test_mediatorBalanceTracksLocksAndUnlocks`, `test_strayTransferIsNeverPaidOut`, `test_feeOnTransferTokenBridgesTheAmountThatArrived`; `mediator/TokenMediatorGaps.t.sol` `test_aTokenThatRelaysDuringAReleaseAndThenRefusesKeepsTheNestedLock` |

### D2. Every bridged copy is backed: record = copy supply + value in flight

| Enforced | Tests |
|---|---|
| `TokenMediator.sol`; `BridgedToken.sol` (mint and burn only by the mediator) | `mediator/TokenMediatorInvariant.t.sol` `invariant_theRecordIsTheCopiesPlusWhatIsInFlight`, `invariant_everyMessageCarriesTheValueThatTheRelayTookIn`; `invariant/MediatorRouterInvariant.t.sol` `invariant_theRecordEqualsTheCopiesPlusTheMessagesInFlight`; `mediator/TokenMediatorFuzz.t.sol` `testFuzz_H13_depositAmountIsLockedAndEmitted`, `testFuzz_H13_feeOnTransferEventEqualsHeldBalance` |

### D3. Only the remote mediator, through the bridge, can release or mint

| Enforced | Tests |
|---|---|
| `TokenMediator.sol` lines 598 to 603 (`NotBridge`, sender, `WrongSourceChain`); `BridgedToken.sol` `mint`, `burn` | `mediator/TokenMediator.t.sol` `test_everyHandlerRefusesACallerThatIsNotTheBridge`, `test_theRemoteMediatorItselfCannotCallAHandlerDirectly`, `test_everyHandlerRefusesAMessageFromAnotherSender`, `test_everyHandlerRefusesAMessageFromAnotherChain`; `mediator/TokenMediatorInvariant.t.sol` `invariant_forgedMessagesChangeNothing`; `MessageBridgeGaps.t.sol` `test_secondBridge_mediatorRefusesAHandlerCallFromTheOtherBridge`; `mediator/BridgedToken.t.sol` `test_onlyTheMediatorCanMint`, `test_onlyTheMediatorCanBurnAndItBurnsItsOwnBalance`; `invariant/TokenFactoryProperties.t.sol` `testFuzz_onlyTheMediatorMintsAndBurnsAndTheSupplyFollows`, `testFuzz_onlyTheMediatorDeploys` |

### D4. A handler never reverts, so a delivered message never loses its tokens to a revert

A token transfer gets the gas left minus `TRANSFER_GAS_RESERVE` (60,000) and at most 32 bytes of return data. A failed transfer is a final `ReleaseFailed`.

| Enforced | Tests |
|---|---|
| `TokenMediator.sol` (`TRANSFER_GAS_RESERVE` at line 149, release path) | `mediator/TokenMediatorInvariant.t.sol` `invariant_noDeliveryFails`; `mediator/TokenMediatorHostileGas.t.sol` `test_aTokenThatBurnsAllItsGasEndsWithAFailedRelease`, `test_aTokenThatRevertsOnEveryTransferEndsWithAFailedRelease`, `test_aBlockedRecipientEndsWithAFailedRelease`, `test_theSameTokenIsPaidWhenTheSenderAsksForMoreGas`; `mediator/TokenMediatorDeployGas.t.sol` `test_gasOfEveryLengthDeploysWithinTheRule`; `DeployBridge.t.sol` `test_deployedBridgeLetsThroughTheGasThatTheMediatorNeeds` |

### D4a. A message never carries a gas limit below the default of its kind or above the bridge maximum

A token relay with a gas limit of zero sends the default of its kind (release 250,000; plus the callback 750,000 with a call; a deploy follows the length of the name and the symbol). A request above zero and below the default reverts with `GasLimitBelowMinimum`. A request above `maxGasPerTx()` reverts with `GasLimitAboveBridgeMaximum`. A plain message sent straight through the bridge has no default and needs a limit of at least 100 (`MIN_GAS_PER_CALL`); a lower one reverts with `GasOutOfRange`. The user call of the router runs inside the call of the mediator, so it never gets more than the message limit.

| Enforced | Tests |
|---|---|
| `TokenMediator.sol` `_chooseGasLimit` | `mediator/TokenMediatorGasLimit.t.sol` `test_aRequestBelowTheDefaultIsRefused`, `test_aRequestOfZeroGivesTheDefault`, `test_aRequestAtTheDefaultIsAccepted`, `test_aDeployRequestBelowTheNameRuleIsRefused`, `test_aRequestAboveTheBridgeMaximumIsRefused`; `mediator/TokenMediatorFuzz.t.sol` `testFuzz_everySentLimitIsAtLeastTheKindMinimumAndAtMostTheMaximum`; `mediator/DeliveryRouterCall.t.sol` `test_theUserCallNeverGetsMoreThanTheMessageGasLimit` |

### D5. A copy lives at the address the factory rule predicts, one copy per (home chain, native token)

| Enforced | Tests |
|---|---|
| `TokenFactory.sol` (`CREATE2`, salt from home chain and native token) | `invariant/TokenFactoryProperties.t.sol` `testFuzz_theCopyIsAtThePredictedAddressWithTheAskedMetadata`, `testFuzz_oneCopyForEachPairAndNoTwoPairsShareAnAddress`; `invariant/MediatorRouterInvariant.t.sol` `invariant_theCopiesAreWhereTheFactoryRuleSaysAndTheRegistriesAgree`; `mediator/TokenMediator.t.sol` `test_copyAddressDoesNotDependOnTheMetadata` |

### D6. A permit signature is used once, by its signer, before its deadline

| Enforced | Tests |
|---|---|
| `BridgedToken.sol` `permit` | `mediator/BridgedToken.t.sol` `test_aPermitCannotBeReplayed`, `test_anExpiredPermitIsRefused`, `test_aPermitSignedByAnotherKeyIsRefused`, `test_aPermitWithTheMalleableTwinOfASignatureIsRefused`, `test_aPermitFromAnOwnerWithTheZeroAddressSignerIsRefused`, `test_theDomainSeparatorFollowsTheStandard` |

## E. Delivery router

### E1. The router keeps nothing it can explain and splits every delivery exactly

After each action the router holds none of the native coin, and its token balance equals refused hand-offs plus stray transfers minus sweeps. Recipient, tip and hand-off add up to the released value. The tip never exceeds the value or the sender's limit, and a direct delivery pays no tip.

| Enforced | Tests |
|---|---|
| `DeliveryRouter.sol` `onTokenBridged` (line 291), `executeMessage` (line 276), `sweep` (line 305) | `invariant/MediatorRouterInvariant.t.sol` `invariant_aRouterHoldsExactlyWhatWasRefusedOrStrayAndNoRunStaysOpen`, `invariant_noViolationAndNoRepeatedExecution`, `invariant_theWrappedNativeTokenIsBackedAndTheCoinIsConserved`; `invariant/RealBridgeInvariant.t.sol` `invariant_routersHoldNothing`; `mediator/DeliveryRouter.t.sol` `test_theFeeNeverExceedsTheValue`, `test_aGasBasedTipNeverExceedsTheValue`, `test_aGasBasedFeeIsCappedByTheLimit`, `test_aDirectDeliveryPaysNoTipInAnyMode`, `test_onlyTheMediatorCanCallOnTokenBridged` |

### E2. Tips go only to the immutable reward address, whoever delivers

| Enforced | Tests |
|---|---|
| `DeliveryRouter.sol` (immutable `rewardAddress`, no caller argument) | `invariant/MediatorRouterInvariant.t.sol` `invariant_theTipGoesToTheRewardAddressAndCallersHoldNothing`; `invariant/RealBridgeInvariant.t.sol` `invariant_onlyTheRewardAddressesReceiveTips`; `mediator/DeliveryRouter.t.sol` `test_aCopyOfADeliveryFromAnyAccountPaysTheIdenticalTip`, `test_anyAccountCanDeliverThroughTheRouter` |

### E3. The router holds no standing approval

| Enforced | Tests |
|---|---|
| `DeliveryRouter.sol` wrap entries (exact approval per wrap) | `mediator/DeliveryRouterWrap.t.sol` `test_theAllowanceToTheMediatorIsZeroBeforeAndAfterEveryWrapEntry` |

## F. Whole-system properties

### F1. No admin, no upgrade, no pause, no refund

| Enforced | Tests |
|---|---|
| Every contract: constructor arguments and constants only | `Immutability.t.sol` `test_H04_noOwnershipOrUpgradeNamesInAbi`, `test_H04_beaconLightClient_onlyUpdateChangesState`, `test_H04_messageBridge_onlySendDeliverAndLayoutFunctionsChangeState`, `test_HB02_beaconForkGate_onlyAdmitConfirmAndSealChangeState`, `test_H09_messageBridgeAndMediatorHaveNoRefundFunction`; `mediator/DeliveryRouter.t.sol` `test_theRouterHasNoOwnerNoClaimAndNoValidatorFilter`; `mediator/BridgedToken.t.sol` `test_theTokenHasNoOwnerAndNoUpgradePath` |

### F2. The bytecode runs on PulseChain (Shanghai) and fits the size limit

| Enforced | Tests |
|---|---|
| `foundry.toml` `evm_version = "shanghai"` | `Bytecode.t.sol` `test_R2_10_noMcopyOrTstoreInHardenedBytecode`, `test_R2_10_hardenedContractsFitTheSizeLimit`, `test_HB02_noMcopyOrTstoreInForkGateBytecode` |

### F3. The deploy script deploys a matched pair against the pinned verifier

Predicted addresses match, each side names the other's real contracts, the verifier code hash is the pinned one, each light client's clock and root match the chain it follows, the bridges start locked, and layouts start empty.

| Enforced | Tests |
|---|---|
| `script/hardened/DeployBridge.s.sol` | `DeployBridge.t.sol` `test_R2_08_predictedAddressesMatchDeployedAddresses`, `test_bridgeOnEachSideNamesTheRealRemoteBridge`, `test_mediatorOnEachSideNamesTheRealMediatorOfTheOtherChain`, `test_postDeployAssertionsCatchAVerifierWhoseCodeIsNotThePinnedCode`, `test_G04_parseConfig_checksTheLightClientClockAgainstTheOtherChain`, `test_HB02_parseConfig_gateRootMustMatchTheChainItFollows`, `test_R2_09_postDeployAssertionsCatchWrongGenesisRoot`, `test_lock_bothBridgesStartLockedWithTheConfiguredCutoff`, `test_HB01_postDeployAssertionsCatchLayoutsThatDoNotStartEmpty`, `test_R2_08_exampleConfigurationIsRefused`; `SP1VerifierGroth16.t.sol` `test_codeHashIsTheDocumentedVerifierCodeHash` |

### F4. The verifier refuses any changed proof, public value or key

| Enforced | Tests |
|---|---|
| Vendored `SP1VerifierGroth16.sol` (circuit v6.1.0) | `SP1VerifierGroth16.t.sol` `test_ownProofIsAcceptedByTheVendoredVerifier`, `test_ownProofWithTamperedPublicValuesIsRefused`, `test_ownProofWithTamperedProofBytesIsRefused`, `test_ownProofUnderAnotherKeyOrWithChangedHeaderIsRefused`, `test_realProofWithOneBitFlippedIsRefused`, `test_proofOfAnotherCircuitIsRefusedEvenWithTheRightSelector`. The proof on file is of an earlier program; see `known-issues.md` 2.2 |
