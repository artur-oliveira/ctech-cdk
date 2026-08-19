import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import * as path from 'node:path';
import {test} from 'node:test';

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'ec2');

const scriptNames = () => readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.sh')).sort();

test('every EC2 asset script parses under bash', () => {
  const names = scriptNames();
  assert.ok(names.length > 0, 'expected at least one script in assets/ec2');
  for (const name of names) {
    execFileSync('bash', ['-n', path.join(ASSETS_DIR, name)], {stdio: 'pipe'});
  }
});

test('every EC2 asset script sets the strict shell options', () => {
  for (const name of scriptNames()) {
    const body = readFileSync(path.join(ASSETS_DIR, name), 'utf8');
    assert.match(body, /^#!\/bin\/bash$/m, `${name}: missing bash shebang`);
    assert.match(body, /^set -euo pipefail$/m, `${name}: missing set -euo pipefail`);
  }
});

test('no EC2 asset script contains CDK or Terraform templating', () => {
  for (const name of scriptNames()) {
    const body = readFileSync(path.join(ASSETS_DIR, name), 'utf8');
    assert.doesNotMatch(body, /\$\{Token\[/, `${name}: contains a CDK token`);
    assert.doesNotMatch(body, /\$\{\s*[a-z_]+\s*\}\s*#\s*terraform/i, `${name}: contains Terraform templating`);
  }
});

test('setup-base.sh requires a service name and enables crond', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-base.sh'), 'utf8');
  assert.match(body, /SERVICE="\$\{1:\?/, 'service name must be a required argument');
  assert.match(body, /systemctl enable --now crond/);
  assert.match(body, /useradd --system --no-create-home --shell \/sbin\/nologin webapp/);
});

test('setup-dualstack.sh opts every AWS client into the dual-stack endpoint', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-dualstack.sh'), 'utf8');
  assert.match(body, /\/etc\/environment/);
  assert.match(body, /\/etc\/amazon\/ssm\/amazon-ssm-agent\.json/);
  assert.match(body, /amazon-cloudwatch-agent\.service\.d\/override\.conf/);
});

test('setup-cloudflare-ca.sh pins the official RSA root by SHA-256', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-cloudflare-ca.sh'), 'utf8');
  assert.match(body, /origin_ca_rsa_root\.pem/);
  assert.match(body, /91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae/);
  assert.match(body, /sha256sum --check --strict/);
  assert.match(body, /openssl x509 .*-checkend 86400/);
  assert.match(body, /update-ca-trust extract/);
  assert.doesNotMatch(body, /BEGIN CERTIFICATE|origin_ca_ecc_root\.pem/);
});
