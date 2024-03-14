package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"

	"github.com/aws/aws-lambda-go/events"
	"github.com/aws/aws-lambda-go/lambda"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/firehose"
	"github.com/aws/aws-sdk-go-v2/service/firehose/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"

	parser "github.com/nekrassov01/access-log-parser"
)

var cfg aws.Config

func init() {
	var err error
	cfg, err = config.LoadDefaultConfig(context.Background())
	if err != nil {
		log.Fatalf("cannot load aws sdk config: %v", err)
	}
}

func handleRequest(ctx context.Context, event events.S3Event) error {
	buf := &bytes.Buffer{}
	p := parser.NewALBRegexParser(ctx, buf, parser.Option{})
	s3client := s3.NewFromConfig(cfg)
	firehoseClient := firehose.NewFromConfig(cfg)
	for _, record := range event.Records {
		obj, err := s3client.GetObject(ctx, &s3.GetObjectInput{
			Bucket: aws.String(record.S3.Bucket.Name),
			Key:    aws.String(record.S3.Object.Key),
		})
		if err != nil {
			return err
		}
		r, err := gzip.NewReader(obj.Body)
		if err != nil {
			return err
		}
		defer r.Close()
		result, err := p.Parse(r)
		if err != nil {
			return err
		}
		b, err := json.Marshal(result)
		if err != nil {
			return err
		}
		fmt.Println(string(b))
	}
	if buf.Len() == 0 {
		return fmt.Errorf("abort process because buffer is empty")
	}
	resp, err := firehoseClient.PutRecordBatch(ctx, &firehose.PutRecordBatchInput{
		DeliveryStreamName: aws.String(os.Getenv("FIREHOSE_STREAM_NAME")),
		Records: []types.Record{
			{
				Data: buf.Bytes(),
			},
		},
	})
	if err != nil {
		return err
	}
	if resp != nil {
		b, err := json.Marshal(resp)
		if err != nil {
			return err
		}
		fmt.Println(string(b))
	}
	return nil
}

func main() {
	lambda.Start(handleRequest)
}
