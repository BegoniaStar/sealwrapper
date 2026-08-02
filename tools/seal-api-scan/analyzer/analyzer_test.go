package analyzer

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFixture(t *testing.T, root string) {
	t.Helper()
	dice := filepath.Join(root, "dice")
	if err := os.MkdirAll(dice, 0o755); err != nil {
		t.Fatal(err)
	}
	fixture := `package dice
type ExtInfo struct { Name string ` + "`jsbind:\"name\"`" + ` }
type Dice struct{}
func Reply(text string) {}
func (d *Dice) JsInit() {
  seal := vm.NewObject()
  ext := vm.NewObject()
  _ = ext.Set("new", func(name string, author string, version string) *ExtInfo { return nil })
  _ = seal.Set("ext", ext)
  _ = seal.Set("reply", Reply)
}`
	if err := os.WriteFile(filepath.Join(dice, "fixture.go"), []byte(fixture), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestScanFindsNestedExportsWithoutBuildingCore(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root)
	result, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if result.ScannerVersion != scannerVersion || len(result.Entries) != 3 {
		t.Fatalf("unexpected result: %#v", result)
	}
	if result.Entries[0].Path != "seal.ext" || result.Entries[1].Path != "seal.ext.new" || result.Entries[2].Path != "seal.reply" {
		t.Fatalf("unexpected entries: %#v", result.Entries)
	}
	if result.Entries[1].Arity != 3 || result.Entries[1].FactoryReturn != "*ExtInfo" {
		t.Fatalf("missing function metadata: %#v", result.Entries[1])
	}
	if result.Types["ExtInfo"].Fields[0].JSName != "name" {
		t.Fatalf("missing jsbind metadata: %#v", result.Types["ExtInfo"])
	}
}

func TestFingerprintIgnoresTestOnlyOverlay(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root)
	before, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "dice", "zz_bridge_test.go"), []byte("package dice\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	after, err := Scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if before.SourceFingerprint != after.SourceFingerprint {
		t.Fatalf("test-only file changed source fingerprint: %s -> %s", before.SourceFingerprint, after.SourceFingerprint)
	}
}

func TestScanReplyGrammarSeparatesProductionAndOverlay(t *testing.T) {
	root := t.TempDir()
	dice := filepath.Join(root, "dice")
	if err := os.MkdirAll(dice, 0o755); err != nil {
		t.Fatal(err)
	}
	production := `package dice
import "reflect"
type ReplyConditionTextMatch struct{}
type ReplyConditionExprTrue struct{}
type ReplyResultReplyToSender struct{}
type ReplyResultRunText struct{}
var conditions = map[string]reflect.Type{"textMatch": reflect.TypeOf(ReplyConditionTextMatch{}), "exprTrue": reflect.TypeOf(ReplyConditionExprTrue{})}
var results = map[string]reflect.Type{"replyToSender": reflect.TypeOf(ReplyResultReplyToSender{}), "runText": reflect.TypeOf(ReplyResultRunText{})}
func (m *ReplyConditionTextMatch) Check() bool { switch "" { case "matchExact": return true; case "matchRegex": return false }; return false }
func (m *ReplyConditionTextMatch) Other() { }
func (m *ReplyConditionTextLenLimit) Check() bool { if "ge" == "" || "le" != "" { return true }; return false }
type ReplyConditionTextLenLimit struct{}
`
	if err := os.WriteFile(filepath.Join(dice, "ext_reply_logic.go"), []byte(production), 0o644); err != nil {
		t.Fatal(err)
	}
	overlay := filepath.Join(dice, "zz_sealwrapper_bridge_test.go")
	overlaySource := `package dice
var knownMatches = map[string]bool{"matchExact": true, "matchRegex": true}
func sealwrapperCheckReplyConditions() { switch "" { case "textMatch", "exprTrue": } ; if "ge" == "" || "le" == "" { } }
func sealwrapperCheckReplyResult() { switch "" { case "replyToSender", "runText": } }
`
	if err := os.WriteFile(overlay, []byte(overlaySource), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := ScanReplyGrammar(root, overlay)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := result.Production.CondTypes, []string{"exprTrue", "textMatch"}; !equalStrings(got, want) {
		t.Fatalf("production cond types: got %#v want %#v", got, want)
	}
	if got, want := result.Production.ResultTypes, []string{"replyToSender", "runText"}; !equalStrings(got, want) {
		t.Fatalf("production result types: got %#v want %#v", got, want)
	}
	if got, want := result.Production.MatchTypes, []string{"matchExact", "matchRegex"}; !equalStrings(got, want) {
		t.Fatalf("production match types: got %#v want %#v", got, want)
	}
	if got, want := result.Overlay.CondTypes, []string{"exprTrue", "textMatch"}; !equalStrings(got, want) {
		t.Fatalf("overlay cond types: got %#v want %#v", got, want)
	}
	if got, want := result.Overlay.ResultTypes, []string{"replyToSender", "runText"}; !equalStrings(got, want) {
		t.Fatalf("overlay result types: got %#v want %#v", got, want)
	}
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
