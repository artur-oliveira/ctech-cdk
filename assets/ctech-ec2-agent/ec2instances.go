package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/ec2"
)

type ec2DescribeInstancesArgs struct {
	ids []string
}

func parseEC2DescribeInstancesArgs(argv []string) (ec2DescribeInstancesArgs, error) {
	fs := flag.NewFlagSet("ec2-describe-instances", flag.ContinueOnError)
	ids := fs.String("ids", "", "comma-separated instance ids")
	if err := fs.Parse(argv); err != nil {
		return ec2DescribeInstancesArgs{}, err
	}
	if *ids == "" {
		return ec2DescribeInstancesArgs{}, fmt.Errorf("-ids is required")
	}
	return ec2DescribeInstancesArgs{ids: strings.Split(*ids, ",")}, nil
}

type instanceStateOutput struct {
	Name string `json:"Name"`
}

type ec2InstanceOutput struct {
	InstanceID       string              `json:"InstanceId"`
	PrivateIPAddress string              `json:"PrivateIpAddress"`
	State            instanceStateOutput `json:"State"`
	LaunchTime       string              `json:"LaunchTime"`
}

type reservationOutput struct {
	Instances []ec2InstanceOutput `json:"Instances"`
}

type describeInstancesOutput struct {
	Reservations []reservationOutput `json:"Reservations"`
}

// runEC2DescribeInstances mirrors `aws ec2 describe-instances --output
// json`'s shape (trimmed to the fields reconcile.sh's jq filters read), so
// reconcile-alpine.sh.tftpl's filters are unchanged. LaunchTime is RFC 3339,
// same as the AWS CLI's JSON output — `date -d` parses both identically.
func runEC2DescribeInstances(ctx context.Context, argv []string) error {
	args, err := parseEC2DescribeInstancesArgs(argv)
	if err != nil {
		return err
	}
	cfg, err := config.LoadDefaultConfig(ctx, config.WithEC2IMDSRegion())
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}
	client := ec2.NewFromConfig(cfg)
	result, err := client.DescribeInstances(ctx, &ec2.DescribeInstancesInput{
		InstanceIds: args.ids,
	})
	if err != nil {
		return fmt.Errorf("describe instances %v: %w", args.ids, err)
	}
	out := describeInstancesOutput{Reservations: []reservationOutput{}}
	for _, r := range result.Reservations {
		reservation := reservationOutput{Instances: []ec2InstanceOutput{}}
		for _, i := range r.Instances {
			launchTime := ""
			if i.LaunchTime != nil {
				launchTime = i.LaunchTime.Format(time.RFC3339)
			}
			reservation.Instances = append(reservation.Instances, ec2InstanceOutput{
				InstanceID:       aws.ToString(i.InstanceId),
				PrivateIPAddress: aws.ToString(i.PrivateIpAddress),
				State:            instanceStateOutput{Name: string(i.State.Name)},
				LaunchTime:       launchTime,
			})
		}
		out.Reservations = append(out.Reservations, reservation)
	}
	return json.NewEncoder(os.Stdout).Encode(out)
}
