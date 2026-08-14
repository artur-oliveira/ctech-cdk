export interface CloudWatchAgentLogFile {
  filePath: string;
  logGroupName: string;
  logStreamName: string;
  retentionInDays?: number;
}

export interface CloudWatchAgentConfigProps {
  /** Namespace for the four low-cardinality host/process metrics. */
  metricNamespace: string;
  logFiles: CloudWatchAgentLogFile[];
  /** Regex matched against the full application command line. */
  appProcessPattern?: string;
  /** Standard-resolution collection interval. Default: 60 seconds. */
  metricsCollectionIntervalSeconds?: number;
}

/**
 * Produces the CloudWatch Agent JSON shared by the EC2 APIs.
 *
 * The metric set is deliberately bounded to four series per active instance:
 * host memory, swap, root-disk usage, and application RSS. EC2 already publishes
 * CPUUtilization and CPUCreditBalance, so duplicating them as custom metrics
 * would only increase cost.
 */
export function buildCloudWatchAgentConfig(props: CloudWatchAgentConfigProps): string {
  const interval = props.metricsCollectionIntervalSeconds ?? 60;
  if (interval < 60) {
    throw new Error('CloudWatch host metrics must use a standard-resolution interval of at least 60 seconds');
  }
  if (props.logFiles.length === 0) {
    throw new Error('At least one CloudWatch log file is required');
  }

  const metricsCollected: Record<string, unknown> = {
    mem: {
      measurement: ['used_percent'],
      metrics_collection_interval: interval,
    },
    swap: {
      measurement: ['used_percent'],
      metrics_collection_interval: interval,
    },
    disk: {
      measurement: ['used_percent'],
      resources: ['/'],
      drop_device: true,
      metrics_collection_interval: interval,
    },
  };
  if (props.appProcessPattern) {
    metricsCollected.procstat = [{
      pattern: props.appProcessPattern,
      measurement: ['memory_rss'],
      metrics_collection_interval: interval,
    }];
  }

  return JSON.stringify({
    agent: {metrics_collection_interval: interval},
    metrics: {
      namespace: props.metricNamespace,
      append_dimensions: {InstanceId: '${aws:InstanceId}'},
      metrics_collected: metricsCollected,
    },
    logs: {
      logs_collected: {
        files: {
          collect_list: props.logFiles.map((file) => ({
            file_path: file.filePath,
            log_group_name: file.logGroupName,
            log_stream_name: file.logStreamName,
            ...(file.retentionInDays === undefined ? {} : {retention_in_days: file.retentionInDays}),
          })),
        },
      },
    },
  }, null, 2);
}
