package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
	cwltypes "github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs/types"
	"github.com/aws/smithy-go"
)

type logsTailFileConfig struct {
	Path         string `json:"path"`
	StreamPrefix string `json:"streamPrefix"`
}

type logsTailConfig struct {
	LogGroup string               `json:"logGroup"`
	Files    []logsTailFileConfig `json:"files"`
}

func loadLogsTailConfig(path string) (logsTailConfig, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return logsTailConfig{}, fmt.Errorf("read config %s: %w", path, err)
	}
	var cfg logsTailConfig
	if err := json.Unmarshal(body, &cfg); err != nil {
		return logsTailConfig{}, fmt.Errorf("parse config %s: %w", path, err)
	}
	if cfg.LogGroup == "" || len(cfg.Files) == 0 {
		return logsTailConfig{}, fmt.Errorf("config %s must set logGroup and at least one file", path)
	}
	return cfg, nil
}

// statInode identifies a file by device+inode, which changes across a
// logrotate rename+recreate even when the path stays the same — the only
// reliable rotation signal without a filesystem-events dependency.
func statInode(path string) (uint64, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	sys, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("unsupported platform: no inode in os.FileInfo.Sys()")
	}
	return sys.Ino, nil
}

// batcher buffers lines until either count or a time interval is reached —
// PutLogEvents needs no sequence token (AWS removed that requirement in
// 2023), so a batcher only has to decide *when* to flush, never track state
// across calls.
type batcher struct {
	mu       sync.Mutex
	max      int
	interval time.Duration
	lines    []string
	since    time.Time
}

func newBatcher(max int, interval time.Duration) *batcher {
	return &batcher{max: max, interval: interval, since: time.Now()}
}

// add reports whether the batch just crossed its size threshold.
func (b *batcher) add(line string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.lines = append(b.lines, line)
	return len(b.lines) >= b.max
}

func (b *batcher) dueForFlush() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.lines) > 0 && time.Since(b.since) >= b.interval
}

func (b *batcher) drain() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.lines
	b.lines = nil
	b.since = time.Now()
	return out
}

// cursorPath derives a stable, filesystem-safe path from the watched file's
// own path, so a restart can find the right cursor without a lookup table.
func cursorPath(watched string) string {
	name := filepath.Base(watched) + "-" + strconv.FormatUint(uint64(len(watched)), 10)
	return filepath.Join("/var/lib/ctech-ec2-agent", name+".pos")
}

type cursor struct {
	Inode  uint64 `json:"inode"`
	Offset int64  `json:"offset"`
}

func loadCursor(watched string) cursor {
	body, err := os.ReadFile(cursorPath(watched))
	if err != nil {
		return cursor{}
	}
	var c cursor
	if json.Unmarshal(body, &c) != nil {
		return cursor{}
	}
	return c
}

func saveCursor(watched string, c cursor) error {
	if err := os.MkdirAll(filepath.Dir(cursorPath(watched)), 0o755); err != nil {
		return err
	}
	body, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(cursorPath(watched), body, 0o644)
}

func streamName(prefix, instanceID string) string {
	return fmt.Sprintf("%s/%s", prefix, instanceID)
}

func ensureLogStream(ctx context.Context, client *cloudwatchlogs.Client, logGroup, stream string) error {
	_, err := client.CreateLogStream(ctx, &cloudwatchlogs.CreateLogStreamInput{
		LogGroupName:  aws.String(logGroup),
		LogStreamName: aws.String(stream),
	})
	if err == nil {
		return nil
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) && apiErr.ErrorCode() == "ResourceAlreadyExistsException" {
		return nil
	}
	return err
}

func flush(ctx context.Context, client *cloudwatchlogs.Client, logGroup, stream string, lines []string) error {
	if len(lines) == 0 {
		return nil
	}
	events := make([]cwltypes.InputLogEvent, 0, len(lines))
	now := time.Now().UnixMilli()
	for _, line := range lines {
		events = append(events, cwltypes.InputLogEvent{
			Message:   aws.String(line),
			Timestamp: aws.Int64(now),
		})
	}
	_, err := client.PutLogEvents(ctx, &cloudwatchlogs.PutLogEventsInput{
		LogGroupName:  aws.String(logGroup),
		LogStreamName: aws.String(stream),
		LogEvents:     events,
	})
	return err
}

// tailOne polls path for growth or rotation every pollInterval, batching
// lines and flushing them to CloudWatch Logs. It runs until ctx is canceled.
func tailOne(ctx context.Context, client *cloudwatchlogs.Client, logGroup, stream, path string, pollInterval time.Duration) error {
	c := loadCursor(path)
	b := newBatcher(100, 5*time.Second)

	for {
		select {
		case <-ctx.Done():
			return nil
		default:
		}

		inode, err := statInode(path)
		if err != nil {
			time.Sleep(pollInterval)
			continue
		}
		if inode != c.Inode {
			// Rotated (or first run): start from the top of the new file.
			c = cursor{Inode: inode, Offset: 0}
		}

		f, err := os.Open(path)
		if err != nil {
			time.Sleep(pollInterval)
			continue
		}
		if _, err := f.Seek(c.Offset, 0); err != nil {
			f.Close()
			time.Sleep(pollInterval)
			continue
		}

		scanner := bufio.NewScanner(f)
		read := int64(0)
		for scanner.Scan() {
			line := scanner.Text()
			read += int64(len(line)) + 1
			if b.add(line) {
				if err := flush(ctx, client, logGroup, stream, b.drain()); err != nil {
					f.Close()
					return fmt.Errorf("flush %s: %w", path, err)
				}
				c.Offset += read
				read = 0
				if err := saveCursor(path, c); err != nil {
					f.Close()
					return fmt.Errorf("save cursor for %s: %w", path, err)
				}
			}
		}
		c.Offset += read
		f.Close()
		if err := saveCursor(path, c); err != nil {
			return fmt.Errorf("save cursor for %s: %w", path, err)
		}

		if b.dueForFlush() {
			if err := flush(ctx, client, logGroup, stream, b.drain()); err != nil {
				return fmt.Errorf("flush %s: %w", path, err)
			}
		}

		time.Sleep(pollInterval)
	}
}

func runLogsTail(ctx context.Context, argv []string) error {
	fs := flag.NewFlagSet("logs-tail", flag.ContinueOnError)
	configPath := fs.String("config", "/etc/ctech-ec2-agent/logs.json", "path to the logs-tail JSON config")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	cfg, err := loadLogsTailConfig(*configPath)
	if err != nil {
		return err
	}

	// No AWS_REGION is set anywhere in userData — resolve it from IMDS instead
	// of failing every call with MissingRegion.
	awsCfg, err := config.LoadDefaultConfig(ctx, config.WithEC2IMDSRegion())
	if err != nil {
		return fmt.Errorf("load AWS config: %w", err)
	}
	client := cloudwatchlogs.NewFromConfig(awsCfg)

	instanceID, err := fetchInstanceID(ctx)
	if err != nil {
		return fmt.Errorf("fetch instance id from IMDS: %w", err)
	}

	var wg sync.WaitGroup
	errs := make(chan error, len(cfg.Files))
	for _, file := range cfg.Files {
		stream := streamName(file.StreamPrefix, instanceID)
		if err := ensureLogStream(ctx, client, cfg.LogGroup, stream); err != nil {
			return fmt.Errorf("create log stream %s: %w", stream, err)
		}
		wg.Add(1)
		go func(path, stream string) {
			defer wg.Done()
			if err := tailOne(ctx, client, cfg.LogGroup, stream, path, time.Second); err != nil {
				errs <- err
			}
		}(file.Path, stream)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		return err
	}
	return nil
}
