package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeCoreFixture(t *testing.T, root string) {
	t.Helper()
	dice := filepath.Join(root, "dice")
	if err := os.MkdirAll(dice, 0o755); err != nil {
		t.Fatal(err)
	}
	fixture := `package dice
type Dice struct{}
func (d *Dice) JsInit() {
  seal := vm.NewObject()
  _ = seal.Set("reply", func(text string) {})
}`
	if err := os.WriteFile(filepath.Join(dice, "fixture.go"), []byte(fixture), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRunRequiresCore(t *testing.T) {
	var stdout, stderr strings.Builder
	if code := run(nil, &stdout, &stderr); code != 2 {
		t.Fatalf("exit code: got %d want 2", code)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "--core is required") {
		t.Fatalf("unexpected output: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestRunWritesInventory(t *testing.T) {
	root := t.TempDir()
	writeCoreFixture(t, root)
	var stdout, stderr strings.Builder
	if code := run([]string{"--core", root}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code: got %d stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), `"scannerVersion"`) || !strings.Contains(stdout.String(), `"seal.reply"`) {
		t.Fatalf("unexpected inventory: %q", stdout.String())
	}
}

func TestRunRejectsInvalidCore(t *testing.T) {
	var stdout, stderr strings.Builder
	if code := run([]string{"--core", t.TempDir()}, &stdout, &stderr); code != 1 {
		t.Fatalf("exit code: got %d want 1", code)
	}
	if stdout.Len() != 0 || !strings.Contains(stderr.String(), "SealDice core directory") {
		t.Fatalf("unexpected output: stdout=%q stderr=%q", stdout.String(), stderr.String())
	}
}

func TestRunWritesReplyGrammar(t *testing.T) {
	root := t.TempDir()
	dice := filepath.Join(root, "dice")
	if err := os.MkdirAll(dice, 0o755); err != nil {
		t.Fatal(err)
	}
	production := `package dice
import "reflect"
type ReplyConditionTextMatch struct{}
type ReplyResultReplyToSender struct{}
var conditions = map[string]reflect.Type{"textMatch": reflect.TypeOf(ReplyConditionTextMatch{})}
var results = map[string]reflect.Type{"replyToSender": reflect.TypeOf(ReplyResultReplyToSender{})}
func (m *ReplyConditionTextMatch) Check() bool { switch "" { case "matchExact": return true }; return false }
`
	overlay := `package dice
var knownMatches = map[string]bool{"matchExact": true}
func sealwrapperCheckReplyConditions() { switch "" { case "textMatch": } }
func sealwrapperCheckReplyResult() { switch "" { case "replyToSender": } }
`
	productionPath := filepath.Join(dice, "ext_reply_logic.go")
	overlayPath := filepath.Join(dice, "zz_sealwrapper_bridge_test.go")
	if err := os.WriteFile(productionPath, []byte(production), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(overlayPath, []byte(overlay), 0o644); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr strings.Builder
	if code := run([]string{"--core", root, "--reply-grammar", "--overlay", overlayPath}, &stdout, &stderr); code != 0 {
		t.Fatalf("exit code: got %d stderr=%q", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), `"production"`) || !strings.Contains(stdout.String(), `"replyToSender"`) {
		t.Fatalf("unexpected reply grammar: %q", stdout.String())
	}
}
