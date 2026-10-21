//! A hand-assembled batch contract for the tests. The repository has no contract that makes two deposits in one
//! transaction, and the tests may not add one, so the tests assemble a tiny one from opcodes.
//!
//! The runtime reads its calldata as records and performs each as a call with value 0, in order. It reverts when a call
//! fails. A record is `target (20 bytes) ‖ length (2 bytes) ‖ payload (length bytes)`. The caller of the inner calls is
//! the batch contract itself, so it can mint, approve and deposit as one account in one transaction.

use alloy_primitives::Address;

const PUSH1: u8 = 0x60;
const PUSH2: u8 = 0x61;
const JUMPDEST: u8 = 0x5b;

/// The runtime code of the batch contract.
pub fn runtime_code() -> Vec<u8> {
    let mut code: Vec<u8> = vec![PUSH1, 0x00]; // the offset into the calldata
    let loop_start = code.len();
    code.push(JUMPDEST);
    // if calldatasize <= offset goto end
    code.extend([0x80, 0x36, 0x11, 0x15]); // DUP1 CALLDATASIZE GT ISZERO
    let end_patch = code.len() + 1;
    code.extend([PUSH2, 0, 0, 0x57]); // PUSH2 end JUMPI
    // target = calldataload(offset) >> 96
    code.extend([0x80, 0x35, PUSH1, 0x60, 0x1c]);
    // length = calldataload(offset + 20) >> 240
    code.extend([0x81, PUSH1, 0x14, 0x01, 0x35, PUSH1, 0xf0, 0x1c]);
    // calldatacopy(0, offset + 22, length)
    code.extend([0x80, 0x83, PUSH1, 0x16, 0x01, PUSH1, 0x00, 0x37]);
    // call(gas, target, 0, 0, length, 0, 0)
    code.extend([PUSH1, 0x00, PUSH1, 0x00, 0x82, PUSH1, 0x00, PUSH1, 0x00, 0x86, 0x5a, 0xf1]);
    // if the call failed goto fail
    code.push(0x15); // ISZERO
    let fail_patch = code.len() + 1;
    code.extend([PUSH2, 0, 0, 0x57]);
    // offset += 22 + length
    code.extend([0x90, 0x50, PUSH1, 0x16, 0x01, 0x01]); // SWAP1 POP PUSH1 22 ADD ADD
    code.extend([PUSH2, (loop_start >> 8) as u8, loop_start as u8, 0x56]); // PUSH2 loop JUMP
    let end = code.len();
    code.extend([JUMPDEST, 0x00]); // end: STOP
    let fail = code.len();
    code.extend([JUMPDEST, PUSH1, 0x00, 0x80, 0xfd]); // fail: REVERT(0, 0)
    code[end_patch] = (end >> 8) as u8;
    code[end_patch + 1] = end as u8;
    code[fail_patch] = (fail >> 8) as u8;
    code[fail_patch + 1] = fail as u8;
    code
}

/// The creation code that deploys [`runtime_code`].
pub fn creation_code() -> Vec<u8> {
    let runtime = runtime_code();
    let length = runtime.len();
    // PUSH1 length DUP1 PUSH1 12 PUSH1 0 CODECOPY PUSH1 0 RETURN, then the runtime. The prefix is 12 bytes long.
    let mut code = vec![PUSH1, length as u8, 0x80, PUSH1, 0x0c, PUSH1, 0x00, 0x39, PUSH1, 0x00, 0xf3];
    // The prefix above is 11 bytes: pad one byte so that the runtime starts at offset 12.
    code.push(0x00);
    assert_eq!(code.len(), 12);
    code.extend(runtime);
    code
}

/// The calldata for the batch contract: one record per `(target, payload)`.
pub fn batch_calldata(calls: &[(Address, Vec<u8>)]) -> Vec<u8> {
    let mut data = Vec::new();
    for (target, payload) in calls {
        data.extend_from_slice(target.as_slice());
        data.extend_from_slice(&(payload.len() as u16).to_be_bytes());
        data.extend_from_slice(payload);
    }
    data
}
