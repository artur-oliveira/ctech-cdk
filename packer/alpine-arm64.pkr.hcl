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
  region        = var.region
  instance_type = "t4g.nano"
  ami_name      = "ctech-alpine-arm64-{{timestamp}}"
  ami_description = "CTech Alpine ARM64 base image — amazon-ssm-agent + ctech-ec2-agent, no aws-cli, no CloudWatch Agent"

  # Alpine's own official AWS cloud image, ARM64, most recent stable release.
  # See https://alpinelinux.org/cloud/ for the current owner/name pattern.
  source_ami_filter {
    filters = {
      name                = "alpine-*-aarch64-uefi-cloudinit-r0"
      architecture        = "arm64"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
    }
    owners      = ["538276064493"] # Alpine Linux's AWS account
    most_recent = true
  }

  ssh_username    = "alpine"
  ami_virtualization_type = "hvm"

  launch_block_device_mappings {
    device_name = "/dev/xvda"
    volume_size = 2 # build-time only; consumer stacks set their own rootVolumeGiB
    volume_type = "gp3"
    delete_on_termination = true
  }
}

build {
  sources = ["source.amazon-ebs.alpine_arm64"]

  provisioner "shell" {
    inline = [
      "sudo apk update",
      "sudo apk add --no-cache amazon-ssm-agent amazon-ssm-agent-openrc",
      "sudo rc-update add amazon-ssm-agent default",
    ]
  }

  provisioner "shell" {
    inline = [
      "sudo mkdir -p /usr/local/bin",
    ]
  }

  provisioner "file" {
    source      = "ctech-ec2-agent"
    destination = "/tmp/ctech-ec2-agent"
  }

  provisioner "shell" {
    inline = [
      "sudo install -m 0755 /tmp/ctech-ec2-agent /usr/local/bin/ctech-ec2-agent",
    ]
  }
}
