/** The fields of the public values that the light client program outputs, in `abi.encode` order. Tests use it to write handoff files. */
export const lightClientOutputParameters = [
  { name: 'genesisValidatorsRoot', type: 'bytes32' },
  { name: 'previousHeaderRoot', type: 'bytes32' },
  { name: 'previousHeadSlot', type: 'uint64' },
  { name: 'previousSyncCommitteeHash', type: 'bytes32' },
  { name: 'startNextSyncCommitteeHash', type: 'bytes32' },
  { name: 'newHeaderRoot', type: 'bytes32' },
  { name: 'newHeadSlot', type: 'uint64' },
  { name: 'executionBlockHash', type: 'bytes32' },
  { name: 'executionBlockNumber', type: 'uint64' },
  { name: 'syncCommitteeHash', type: 'bytes32' },
  { name: 'nextSyncCommitteeHash', type: 'bytes32' },
] as const
