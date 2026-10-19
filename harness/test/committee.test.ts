import { recoverAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  attest,
  committeeLeaf,
  createCommittee,
  merkleProofFor,
  signingRootFor,
  verifyMerkleProof,
} from '../src/committee.js'
import { COMMITTEE_SIZE, COMMITTEE_TREE_DEPTH, SIGNATURE_QUORUM, ZERO_HASH } from '../src/constants.js'

const attestedHeader = `0x${'ab'.repeat(32)}` as const

describe('committee', () => {
  it('has 512 members and proofs nine hashes deep', () => {
    const committee = createCommittee('chainA')
    expect(committee.members).toHaveLength(COMMITTEE_SIZE)
    expect(merkleProofFor(committee, 0)).toHaveLength(COMMITTEE_TREE_DEPTH)
  })

  it('proves every member against the root, and rejects a stranger', () => {
    const committee = createCommittee('chainA')
    for (const member of committee.members) {
      expect(verifyMerkleProof(merkleProofFor(committee, member.leafIndex), committee.root, committeeLeaf(member.address))).toBe(true)
    }
    // Control: a leaf that is not in the tree must fail with the same proof.
    const stranger = committeeLeaf('0x000000000000000000000000000000000000dEaD')
    expect(verifyMerkleProof(merkleProofFor(committee, 0), committee.root, stranger)).toBe(false)
  })

  it('gives different committees different roots', () => {
    expect(createCommittee('chainA').root).not.toBe(createCommittee('chainB').root)
    expect(createCommittee('chainA').root).not.toBe(ZERO_HASH)
  })

  it('signs the raw signing root with strictly ascending signers', async () => {
    const committee = createCommittee('chainA')
    const { signatures, merkleProofs } = await attest({ committee, attestedHeader, period: 1 })
    expect(signatures).toHaveLength(SIGNATURE_QUORUM)
    expect(merkleProofs).toHaveLength(SIGNATURE_QUORUM)
    const hash = signingRootFor(attestedHeader, 1)
    const recovered = await Promise.all(signatures.map((signature) => recoverAddress({ hash, signature })))
    for (let position = 1; position < recovered.length; position++) {
      expect(BigInt(recovered[position]!)).toBeGreaterThan(BigInt(recovered[position - 1]!))
    }
    const memberAddresses = new Set(committee.members.map((member) => member.address))
    expect(recovered.every((address) => memberAddresses.has(address))).toBe(true)
    // Control: a different period gives a different digest, so signers recover to other addresses.
    const otherPeriod = await recoverAddress({ hash: signingRootFor(attestedHeader, 2), signature: signatures[0]! })
    expect(otherPeriod).not.toBe(recovered[0])
  })
})
