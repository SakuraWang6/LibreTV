import { describe, expect, it } from 'vitest';
import { nonPublicAddress, parseDnsAnswer } from './trusted-dns';

describe('trusted DNS retains the public socket boundary', () => {
  it('accepts matching authenticated-provider A answers including AliDNS Question shape', () => {
    const answer = { Status: 0, Question: { name: 'video.example.', type: 1 }, Answer: [{ type: 5, data: 'cdn.example.' }, { type: 1, data: '151.101.2.132', TTL: 300 }] };
    expect(parseDnsAnswer(answer, 'video.example')).toEqual({ addresses: [{ address: '151.101.2.132', family: 4 }], ttl: 60 });
    expect(parseDnsAnswer({ ...answer, Question: [answer.Question] }, 'video.example').addresses).toHaveLength(1);
  });

  it('never accepts fake-IP, metadata, private, multicast or benchmark IPv6 answers', () => {
    for (const address of ['198.18.0.36', '169.254.169.254', '127.0.0.1', '10.0.0.1', '224.0.0.1', '2001:2::2d']) {
      expect(nonPublicAddress(address)).toBe(true);
      expect(() => parseDnsAnswer({ Status: 0, Question: [{ name: 'video.example', type: 1 }], Answer: [{ type: 1, data: address }] }, 'video.example')).toThrow();
    }
  });

  it('rejects unrelated questions and failed DNS responses', () => {
    const answer = { Status: 0, Question: [{ name: 'other.example', type: 1 }], Answer: [{ type: 1, data: '8.8.8.8' }] };
    expect(() => parseDnsAnswer(answer, 'video.example')).toThrow('匹配');
    expect(() => parseDnsAnswer({ ...answer, Status: 2 }, 'other.example')).toThrow('匹配');
  });
});
