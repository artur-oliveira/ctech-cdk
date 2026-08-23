import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import {
  addCloudflareOriginCaCommandsAlpine,
  addDualStackSsmAgentCommandsAlpine,
} from '../lib/ec2-userdata-fragments-alpine';

test('addDualStackSsmAgentCommandsAlpine writes the OpenRC-restart form, not systemctl', () => {
  const userData = ec2.UserData.forLinux();
  addDualStackSsmAgentCommandsAlpine(userData);
  const rendered = userData.render();
  assert.match(rendered, /AWS_USE_DUALSTACK_ENDPOINT=true/);
  assert.match(rendered, /\/etc\/amazon\/ssm\/amazon-ssm-agent\.json/);
  assert.match(rendered, /rc-service amazon-ssm-agent restart/);
  assert.doesNotMatch(rendered, /systemctl/);
});

test('addCloudflareOriginCaCommandsAlpine uses update-ca-certificates', () => {
  const userData = ec2.UserData.forLinux();
  addCloudflareOriginCaCommandsAlpine(userData);
  const rendered = userData.render();
  assert.match(rendered, /origin_ca_rsa_root\.pem/);
  assert.match(rendered, /91a8a5567efa6bf941162aa806b3ba476aaddf7867640e53053b35fb225a5dae/);
  assert.match(rendered, /update-ca-certificates/);
  assert.doesNotMatch(rendered, /update-ca-trust/);
});
