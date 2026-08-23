packer {
  required_plugins {
    amazon = {
      version = ">= 1.3.0"
      source  = "github.com/hashicorp/amazon"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

source "amazon-ebs" "alpine_arm64" {
  region          = var.region
  instance_type   = "t4g.nano"
  ami_name = "ctech-alpine-arm64-{{timestamp}}"
  # AWS AMI descriptions reject non-ASCII characters (no em dash).
  ami_description = "CTech Alpine ARM64 base image - amazon-ssm-agent + ctech-ec2-agent, no aws-cli, no CloudWatch Agent"

  # Alpine's own official AWS cloud image, ARM64, most recent stable release.
  # See https://alpinelinux.org/cloud/ for the current owner/name pattern.
  source_ami_filter {
    filters = {
      name                = "alpine-*-aarch64-uefi-cloudinit-r0"
      architecture        = "arm64"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
    }
    owners = ["538276064493"] # Alpine Linux's AWS account
    most_recent = true
  }

  ssh_username            = "alpine"
  ami_virtualization_type = "hvm"

  # AWS's own auto-generated snapshot Description ("Created by CreateImage(...)
  # for ami-...") is not overridable through this builder — it is set by the
  # CreateImage call itself and immutable after creation. Tags are the
  # supported way to make the AMI and its snapshot identifiable; they apply to
  # both by default (see the repo-wide Name/Project tagging convention).
  tags = {
    Name    = "ctech-alpine-arm64"
    Project = "ctech-cdk"
  }

  # Encrypts the AMI's backing snapshot at rest, matching every consumer
  # stack's own encrypted:true on its launch template volume (defense in
  # depth: the source image is encrypted independently of the consumer).
  encrypt_boot = true

  launch_block_device_mappings {
    device_name           = "/dev/xvda"
    # Matches consumer stacks' rootVolumeGiB target (spec's disk budget) —
    # confirmed sufficient: actual build output measured at 413 MiB.
    volume_size           = 1
    volume_type           = "gp3"
    delete_on_termination = true
  }
}

build {
  sources = ["source.amazon-ebs.alpine_arm64"]

  provisioner "shell" {
    # Alpine's official cloud images have no sudo — doas is the native
    # privilege-escalation tool (already installed, "alpine" user pre-permitted
    # nopass), the same "use Alpine-native tooling" rule as apk over dnf and
    # rc-service over systemctl elsewhere in this pipeline.
    inline = [
      "doas apk update",
      "doas apk add --no-cache amazon-ssm-agent amazon-ssm-agent-openrc",
      "doas rc-update add amazon-ssm-agent default",
    ]
  }

  provisioner "shell" {
    inline = [
      "doas mkdir -p /usr/local/bin",
    ]
  }

  provisioner "file" {
    source      = "ctech-ec2-agent"
    destination = "/tmp/ctech-ec2-agent"
  }

  provisioner "shell" {
    inline = [
      "doas install -m 0755 /tmp/ctech-ec2-agent /usr/local/bin/ctech-ec2-agent",
    ]
  }
}
