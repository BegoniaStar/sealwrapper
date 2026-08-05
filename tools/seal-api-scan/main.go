package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"sealwrapper-api-scan/analyzer"
)

func run(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("seal-api-scan", flag.ContinueOnError)
	flags.SetOutput(stderr)
	core := flags.String("core", "", "read-only managed SealDice core directory")
	overlay := flags.String("overlay", "", "applied test-only bridge Go file (used with --reply-grammar)")
	replyGrammar := flags.Bool("reply-grammar", false, "extract production and overlay reply grammar as JSON")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if *core == "" {
		fmt.Fprintln(stderr, "seal-api-scan: --core is required")
		return 2
	}
	if *replyGrammar {
		result, err := analyzer.ScanReplyGrammar(*core, *overlay)
		if err != nil {
			fmt.Fprintf(stderr, "seal-api-scan: %v\n", err)
			return 1
		}
		data, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			fmt.Fprintf(stderr, "seal-api-scan: encode reply grammar: %v\n", err)
			return 1
		}
		if _, err := fmt.Fprintln(stdout, string(data)); err != nil {
			fmt.Fprintf(stderr, "seal-api-scan: write reply grammar: %v\n", err)
			return 1
		}
		return 0
	}
	result, err := analyzer.Scan(*core)
	if err != nil {
		fmt.Fprintf(stderr, "seal-api-scan: %v\n", err)
		return 1
	}
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintf(stderr, "seal-api-scan: encode result: %v\n", err)
		return 1
	}
	if _, err := fmt.Fprintln(stdout, string(data)); err != nil {
		fmt.Fprintf(stderr, "seal-api-scan: write result: %v\n", err)
		return 1
	}
	return 0
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}
