import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const hcl = fs.readFileSync(path.join(__dirname, '..', 'packer', 'alpine-arm64.pkr.hcl'), 'utf8');

// Regression of 2026-11-03: "alpine-*" matched every Alpine series and most_recent picked 3.22.7,
// whose amazon-ssm-agent predates UseDualStackEndpoint, so no instance registered with SSM.
describe('packer/alpine-arm64.pkr.hcl', () => {
  it('pins the Alpine series in the source AMI filter', () => {
    const name = /name\s*=\s*"(alpine-[^"]*aarch64-uefi-cloudinit-r0)"/.exec(hcl)?.[1];
    assert.ok(name, 'source_ami_filter name not found');
    assert.match(name, /^alpine-3\.\d+\.\*-aarch64/);
  });

  it('requires an amazon-ssm-agent that supports UseDualStackEndpoint (>= 3.3.3270)', () => {
    const m = /apk add[^"]*'amazon-ssm-agent>=(\d+)\.(\d+)\.(\d+)'/.exec(hcl);
    assert.ok(m, 'amazon-ssm-agent version constraint not found');
    assert.deepEqual([Number(m[1]), Number(m[2])], [3, 3]);
    assert.ok(Number(m[3]) >= 3270);
  });
});
