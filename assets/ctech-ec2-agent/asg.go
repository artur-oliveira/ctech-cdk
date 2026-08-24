package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/autoscaling"
)

func newASGClient(ctx context.Context) (*autoscaling.Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx, config.WithEC2IMDSRegion())
	if err != nil {
		return nil, fmt.Errorf("load AWS config: %w", err)
	}
	return autoscaling.NewFromConfig(cfg), nil
}

type asgDescribeArgs struct {
	names []string
}

func parseASGDescribeArgs(argv []string) (asgDescribeArgs, error) {
	fs := flag.NewFlagSet("asg-describe", flag.ContinueOnError)
	names := fs.String("names", "", "comma-separated auto scaling group names")
	if err := fs.Parse(argv); err != nil {
		return asgDescribeArgs{}, err
	}
	if *names == "" {
		return asgDescribeArgs{}, fmt.Errorf("-names is required")
	}
	return asgDescribeArgs{names: strings.Split(*names, ",")}, nil
}

type asgInstanceOutput struct {
	InstanceID     string `json:"InstanceId"`
	LifecycleState string `json:"LifecycleState"`
	HealthStatus   string `json:"HealthStatus"`
}

type autoScalingGroupOutput struct {
	AutoScalingGroupName string              `json:"AutoScalingGroupName"`
	Instances            []asgInstanceOutput `json:"Instances"`
}

type describeASGOutput struct {
	AutoScalingGroups []autoScalingGroupOutput `json:"AutoScalingGroups"`
}

// runASGDescribe mirrors `aws autoscaling describe-auto-scaling-groups
// --output json`'s shape (trimmed to the fields reconcile.sh's jq filters
// read), so reconcile-alpine.sh.tftpl's filters are unchanged.
func runASGDescribe(ctx context.Context, argv []string) error {
	args, err := parseASGDescribeArgs(argv)
	if err != nil {
		return err
	}
	client, err := newASGClient(ctx)
	if err != nil {
		return err
	}
	result, err := client.DescribeAutoScalingGroups(ctx, &autoscaling.DescribeAutoScalingGroupsInput{
		AutoScalingGroupNames: args.names,
	})
	if err != nil {
		return fmt.Errorf("describe auto scaling groups %v: %w", args.names, err)
	}
	out := describeASGOutput{AutoScalingGroups: []autoScalingGroupOutput{}}
	for _, g := range result.AutoScalingGroups {
		group := autoScalingGroupOutput{
			AutoScalingGroupName: aws.ToString(g.AutoScalingGroupName),
			Instances:            []asgInstanceOutput{},
		}
		for _, i := range g.Instances {
			group.Instances = append(group.Instances, asgInstanceOutput{
				InstanceID:     aws.ToString(i.InstanceId),
				LifecycleState: string(i.LifecycleState),
				HealthStatus:   aws.ToString(i.HealthStatus),
			})
		}
		out.AutoScalingGroups = append(out.AutoScalingGroups, group)
	}
	return json.NewEncoder(os.Stdout).Encode(out)
}
