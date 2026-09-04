import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import * as path from 'node:path';
import {test} from 'node:test';
import {SSM} from '../lib';

const ASSETS_DIR = path.join(__dirname, '..', 'assets', 'ec2-alpine');

const scriptNames = () => readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.sh')).sort();

test('every Alpine EC2 asset script parses under bash', () => {
  const names = scriptNames();
  assert.ok(names.length > 0, 'expected at least one script in assets/ec2-alpine');
  for (const name of names) {
    execFileSync('bash', ['-n', path.join(ASSETS_DIR, name)], {stdio: 'pipe'});
  }
});

test('every Alpine EC2 asset script sets the strict shell options', () => {
  for (const name of scriptNames()) {
    const body = readFileSync(path.join(ASSETS_DIR, name), 'utf8');
    assert.match(body, /^#!\/bin\/bash$/m, `${name}: missing bash shebang`);
    assert.match(body, /^set -euo pipefail$/m, `${name}: missing set -euo pipefail`);
  }
});

test('no Alpine EC2 asset script uses systemd or dnf', () => {
  for (const name of scriptNames()) {
    const body = readFileSync(path.join(ASSETS_DIR, name), 'utf8');
    assert.doesNotMatch(body, /systemctl|journalctl/, `${name}: still calls systemd tooling`);
    assert.doesNotMatch(body, /\bdnf\b/, `${name}: still calls dnf`);
  }
});

test('setup-base.sh uses apk and adduser, and enables no cron unit AL2023 needed', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-base.sh'), 'utf8');
  assert.match(body, /SERVICE="\$\{1:\?/);
  assert.match(body, /apk add --no-cache/);
  assert.match(body, /addgroup -S webapp/);
  assert.match(body, /adduser -S -D -H -G webapp -s \/sbin\/nologin webapp/);
});

test('setup-base.sh points chronyd at the Amazon Time Sync Service, not pool.ntp.org', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-base.sh'), 'utf8');
  assert.match(body, /server 169\.254\.169\.123 prefer iburst/, 'must sync from the link-local Time Sync Service, reachable with no internet egress');
  assert.doesNotMatch(body, /pool\.ntp\.org/, 'pool.ntp.org is unreachable from this VPC and must not be configured as a source');
  assert.match(body, /rm -f \/var\/lib\/chrony\/chrony\.drift/, 'a stale drift estimate from a prior boot must not blend into a fresh sync');
  assert.match(body, /rc-service chronyd restart/);
});

test('setup-dualstack.sh writes OpenRC conf.d, not a systemd override', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-dualstack.sh'), 'utf8');
  assert.match(body, /\/etc\/environment/);
  assert.match(body, /\/etc\/amazon\/ssm\/amazon-ssm-agent\.json/);
  assert.match(body, /\/etc\/conf\.d\/ctech-ec2-agent/);
  assert.doesNotMatch(body, /\.service\.d/);
});

test('setup-ctech-ec2-agent.sh installs the binary and starts the logs-tail service', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-ctech-ec2-agent.sh'), 'utf8');
  assert.match(body, /CONFIG="\$\{1:\?/, 'logs-tail config path must be a required argument');
  assert.match(body, /SERVICE_NAME="ctech-ec2-agent-logs\$\{SUFFIX:\+-\$SUFFIX\}"/, 'must default to the original single-service name when no suffix is given');
  assert.match(body, /rc-update add "\$SERVICE_NAME" default/);
  assert.match(body, /rc-service "\$SERVICE_NAME" start/);
});

test('setup-nginx.sh keeps both extension points and never double-includes realip', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-nginx.sh'), 'utf8');
  assert.match(body, /include \/etc\/nginx\/conf\.d\/realip\*\.conf;/);
  assert.match(body, /include \/etc\/nginx\/conf\.d\/http-\*\.conf;/);
  assert.match(body, /include \/etc\/nginx\/conf\.d\/location-\*\.conf;/);
  assert.match(body, /include \/etc\/nginx\/conf\.d\/proxy-\*\.conf;/);
  assert.match(body, /rc-service nginx start/);
});

test('setup-realip.sh calls ctech-ec2-agent prefix-list, not the AWS CLI', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-realip.sh'), 'utf8');
  assert.match(body, /VPC_CIDR="\$\{1:\?/);
  assert.match(body, /ctech-ec2-agent prefix-list/);
  assert.doesNotMatch(body, /\baws ec2\b/);
  assert.match(body, /RANDOM % 3600/, 'must jitter the daily periodic run itself, no systemd timer');
});

test('setup-cloudflare-ca.sh uses update-ca-certificates, not update-ca-trust', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-cloudflare-ca.sh'), 'utf8');
  assert.match(body, /91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae/);
  assert.match(body, /\/usr\/local\/share\/ca-certificates\//);
  assert.match(body, /update-ca-certificates/);
  assert.doesNotMatch(body, /update-ca-trust|\/etc\/pki\//);
});

test('setup-ssm-env.sh calls ctech-ec2-agent ssm-get, not the AWS CLI', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-ssm-env.sh'), 'utf8');
  assert.match(body, /ctech-ec2-agent ssm-get/);
  assert.doesNotMatch(body, /aws ssm get-parameter/);
});

test('setup-deploy.sh calls ctech-ec2-agent s3-cp and reads the OpenRC log file, not journalctl', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-deploy.sh'), 'utf8');
  assert.match(body, /ctech-ec2-agent s3-cp/);
  assert.match(body, /rc-service "\$unit" restart/);
  assert.doesNotMatch(body, /journalctl/);
});

test('bootstrap-deploy.sh calls ctech-ec2-agent s3-head, not the AWS CLI', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'bootstrap-deploy.sh'), 'utf8');
  assert.match(body, /ctech-ec2-agent s3-head/);
  assert.doesNotMatch(body, /s3api head-object/);
});

test('setup-swap.sh is idempotent and never calls the AWS CLI', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-swap.sh'), 'utf8');
  assert.match(body, /SIZE_MB="\$\{1:-256\}"/);
  assert.match(body, /if \[ -f \/var\/swapfile \]; then/);
  assert.match(body, /mkswap \/var\/swapfile/);
});

test('setup-logs.sh calls ctech-ec2-agent s3-put, not the AWS CLI', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-logs.sh'), 'utf8');
  assert.match(body, /LOGS_BUCKET="\$\{1:\?/);
  assert.match(body, /ctech-ec2-agent s3-put -bucket __LOGS_BUCKET__ -key/);
  assert.doesNotMatch(body, /aws s3 cp/);
});

test('SSM path helpers used to publish this bucket exist', () => {
  assert.equal(SSM.ec2ScriptsAlpine('prod').bucket, '/ctech/prod/ec2-scripts-alpine/bucket');
});
