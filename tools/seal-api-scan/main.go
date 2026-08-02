package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"sealwrapper-api-scan/analyzer"
)

func main() {
	core := flag.String("core", "", "read-only managed SealDice core directory")
	overlay := flag.String("overlay", "", "applied test-only bridge Go file (used with --reply-grammar)")
	replyGrammar := flag.Bool("reply-grammar", false, "extract production and overlay reply grammar as JSON")
	flag.Parse()
	if *core == "" {
		fmt.Fprintln(os.Stderr, "seal-api-scan: --core is required")
		os.Exit(2)
	}
	if *replyGrammar {
		result, err := analyzer.ScanReplyGrammar(*core, *overlay)
		if err != nil {
			fmt.Fprintf(os.Stderr, "seal-api-scan: %v\n", err)
			os.Exit(1)
		}
		data, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "seal-api-scan: encode reply grammar: %v\n", err)
			os.Exit(1)
		}
		_, _ = os.Stdout.Write(append(data, '\n'))
		return
	}
	result, err := analyzer.Scan(*core)
	if err != nil {
		fmt.Fprintf(os.Stderr, "seal-api-scan: %v\n", err)
		os.Exit(1)
	}
	data, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "seal-api-scan: encode result: %v\n", err)
		os.Exit(1)
	}
	_, _ = os.Stdout.Write(append(data, '\n'))
}
