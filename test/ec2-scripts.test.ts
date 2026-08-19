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

test('setup-realip.sh refuses a partial CloudFront prefix list and requires a CIDR', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-realip.sh'), 'utf8');
  assert.match(body, /VPC_CIDR="\$\{1:\?/, 'VPC CIDR must be a required argument');
  assert.match(body, /com\.amazonaws\.global\.cloudfront\.origin-facing/);
  assert.match(body, /-lt 10/, 'must bail when fewer than 10 CloudFront prefixes come back');
  assert.match(body, /real_ip_recursive on/);
  assert.match(body, /systemctl enable --now update-realip\.timer/);
});

test('setup-nginx.sh exposes both extension points and never double-includes realip', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-nginx.sh'), 'utf8');
  assert.match(body, /include \/etc\/nginx\/conf\.d\/realip\*\.conf;/);
  assert.match(body, /include \/etc\/nginx\/conf\.d\/http-\*\.conf;/);
  assert.match(body, /include \/etc\/nginx\/conf\.d\/location-\*\.conf;/);
  assert.doesNotMatch(body, /include \/etc\/nginx\/conf\.d\/\*\.conf;/);
  assert.match(body, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(body, /proxy_add_x_forwarded_for/);
  assert.match(body, /nginx -t/);
});

test('setup-ssm-env.sh rejects an argument that is not VAR=/path', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-ssm-env.sh'), 'utf8');
  assert.match(body, /expected VAR=\/ssm\/path/);
  assert.match(body, /printf '%s=\$\(_ctech_ssm %q\)/, 'paths must be shell-quoted with %q');
});

test('setup-ssm-env.sh generates a loader read at service start, not at boot', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-ssm-env.sh'), 'utf8');
  assert.match(body, /\/opt\/app\/load-ssm-env\.sh/);
  // The generated file must contain the aws call, not its result.
  assert.match(body, /aws ssm get-parameter/);
});

test('setup-app-service.sh sources the three env layers in order', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-app-service.sh'), 'utf8');
  const release = body.indexOf('release.env');
  const ssmEnv = body.indexOf('load-ssm-env.sh');
  const serviceEnv = body.indexOf('service-env.sh');
  const exec = body.indexOf('exec /opt/app/current/');
  assert.ok(release > 0 && ssmEnv > release && serviceEnv > ssmEnv && exec > serviceEnv,
    'start.sh must source release.env, then load-ssm-env.sh, then service-env.sh, then exec');
  assert.match(body, /EnvironmentFile=\/etc\/app-static\.env/);
});

test('setup-cloudwatch-agent.sh requires a config file and runs fetch-config', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-cloudwatch-agent.sh'), 'utf8');
  assert.match(body, /CONFIG="\$\{1:\?/);
  assert.match(body, /amazon-cloudwatch-agent-ctl -a fetch-config -m ec2/);
});

test('setup-deploy.sh keeps the health-gated release swap', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-deploy.sh'), 'utf8');
  assert.match(body, /ln -sfT "\$RELEASE_DIR" \/opt\/app\/current/);
  assert.match(body, /systemctl is-failed --quiet app/);
  assert.match(body, /journalctl -u app --no-pager/);
  assert.match(body, /tail -n \+2 \| xargs rm -rf/, 'must prune all but the live release');
});

test('setup-logs.sh never fails the logrotate run', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'setup-logs.sh'), 'utf8');
  assert.match(body, /X-aws-ec2-metadata-token-ttl-seconds/, 'IMDSv2 is enforced');
  assert.match(body, /\|\| exit 0/, 'every failure path must exit 0');
  assert.match(body, /postrotate/);
});

test('bootstrap-deploy.sh tolerates a missing first artifact', () => {
  const body = readFileSync(path.join(ASSETS_DIR, 'bootstrap-deploy.sh'), 'utf8');
  assert.match(body, /s3api head-object/);
  assert.match(body, /waiting for first deploy/);
});
