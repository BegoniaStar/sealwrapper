// Package analyzer extracts the JavaScript surface registered by Dice.JsInit.
// It only parses Go syntax; it never imports, builds, or executes core code.
package analyzer

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

const scannerVersion = 2

// Result is a deterministic low-level description of the JsInit API.
type Result struct {
	ScannerVersion    int             `json:"scannerVersion"`
	SourceFingerprint string          `json:"sourceFingerprint"`
	Entries           []Entry         `json:"entries"`
	Types             map[string]Type `json:"types"`
}

// Entry describes a member registered on seal or one of its child objects.
type Entry struct {
	Path          string `json:"path"`
	Kind          string `json:"kind"`
	GoSignature   string `json:"goSignature,omitempty"`
	Arity         int    `json:"arity,omitempty"`
	FactoryReturn string `json:"factoryReturn,omitempty"`
	Source        string `json:"source"`
}

// Type and Field preserve Go metadata for the reviewed semantic layer.
type Type struct {
	Kind   string  `json:"kind"`
	Fields []Field `json:"fields,omitempty"`
	Target string  `json:"target,omitempty"`
}

type Field struct {
	GoName string `json:"goName"`
	JSName string `json:"jsName,omitempty"`
	Type   string `json:"type"`
	Tag    string `json:"tag,omitempty"`
}

// Scan reads only dice/*.go production sources. Test files are deliberately
// excluded from both parsing and the fingerprint so the bridge overlay cannot
// alter an API inventory.
func Scan(core string) (Result, error) {
	root, err := filepath.Abs(core)
	if err != nil {
		return Result{}, err
	}
	diceDirectory := filepath.Join(root, "dice")
	info, err := os.Stat(diceDirectory)
	if err != nil || !info.IsDir() {
		return Result{}, fmt.Errorf("%s is not a SealDice core directory with dice/", root)
	}
	fingerprint, err := fingerprintDiceSource(diceDirectory)
	if err != nil {
		return Result{}, err
	}
	fset := token.NewFileSet()
	packages, err := parser.ParseDir(fset, diceDirectory, productionGoFile, parser.ParseComments)
	if err != nil {
		return Result{}, fmt.Errorf("parse dice package: %w", err)
	}
	pkg, ok := packages["dice"]
	if !ok {
		return Result{}, fmt.Errorf("dice package not found in %s", diceDirectory)
	}
	functions := map[string]*ast.FuncDecl{}
	types := map[string]Type{}
	var jsInit *ast.FuncDecl
	for _, file := range pkg.Files {
		for _, declaration := range file.Decls {
			switch node := declaration.(type) {
			case *ast.FuncDecl:
				if node.Recv == nil {
					functions[node.Name.Name] = node
				}
				if node.Name.Name == "JsInit" && node.Recv != nil {
					jsInit = node
				}
			case *ast.GenDecl:
				collectTypes(fset, node, types)
			}
		}
	}
	if jsInit == nil || jsInit.Body == nil {
		return Result{}, fmt.Errorf("Dice.JsInit was not found")
	}
	entries := scanJsInit(root, fset, jsInit, functions)
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	return Result{
		ScannerVersion:    scannerVersion,
		SourceFingerprint: "sha256:" + fingerprint,
		Entries:           entries,
		Types:             types,
	}, nil
}

func productionGoFile(info fs.FileInfo) bool {
	name := info.Name()
	return strings.HasSuffix(name, ".go") && !strings.HasSuffix(name, "_test.go")
}

func scanJsInit(root string, fset *token.FileSet, jsInit *ast.FuncDecl, functions map[string]*ast.FuncDecl) []Entry {
	type setCall struct {
		receiver string
		name     string
		value    ast.Expr
		entry    Entry
	}
	calls := []setCall{}
	ast.Inspect(jsInit.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "Set" || len(call.Args) < 2 {
			return true
		}
		receiver, ok := selector.X.(*ast.Ident)
		if !ok {
			return true
		}
		name, ok := stringLiteral(call.Args[0])
		if !ok {
			return true
		}
		entry := describeSetValue(fset, call.Args[1], functions)
		entry.Source = sourceLocation(root, fset, call.Pos())
		calls = append(calls, setCall{receiver: receiver.Name, name: name, value: call.Args[1], entry: entry})
		return true
	})
	paths := map[string]string{"seal": "seal"}
	entries := map[string]Entry{}
	for progress := true; progress; {
		progress = false
		for _, call := range calls {
			parent, known := paths[call.receiver]
			if !known {
				continue
			}
			entry := call.entry
			entry.Path = parent + "." + call.name
			if _, exists := entries[entry.Path]; !exists {
				entries[entry.Path] = entry
				progress = true
			}
			if entry.Kind == "object" {
				if identifier, ok := call.value.(*ast.Ident); ok && paths[identifier.Name] != entry.Path {
					paths[identifier.Name] = entry.Path
					progress = true
				}
			}
		}
	}
	result := make([]Entry, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry)
	}
	return result
}

func describeSetValue(fset *token.FileSet, expression ast.Expr, functions map[string]*ast.FuncDecl) Entry {
	switch value := expression.(type) {
	case *ast.FuncLit:
		return entryFromFuncType(fset, value.Type)
	case *ast.Ident:
		if declaration, found := functions[value.Name]; found {
			return entryFromFuncType(fset, declaration.Type)
		}
		return Entry{Kind: "object"}
	case *ast.CallExpr:
		if selector, ok := value.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "NewObject" {
			return Entry{Kind: "object"}
		}
		if identifier, ok := value.Fun.(*ast.Ident); ok {
			if declaration, found := functions[identifier.Name]; found && declaration.Type.Results != nil && len(declaration.Type.Results.List) > 0 {
				if function, isFunction := declaration.Type.Results.List[0].Type.(*ast.FuncType); isFunction {
					return entryFromFuncType(fset, function)
				}
			}
		}
	}
	return Entry{Kind: "unknown"}
}

func entryFromFuncType(fset *token.FileSet, function *ast.FuncType) Entry {
	entry := Entry{Arity: fieldArity(function.Params), GoSignature: functionSignature(fset, function), Kind: "function"}
	if function.Results != nil && len(function.Results.List) > 0 {
		entry.FactoryReturn = nodeString(fset, function.Results.List[0].Type)
	}
	return entry
}

func functionSignature(fset *token.FileSet, function *ast.FuncType) string {
	parameters := fieldTypes(fset, function.Params)
	results := fieldTypes(fset, function.Results)
	signature := "func(" + strings.Join(parameters, ", ") + ")"
	switch len(results) {
	case 0:
		return signature
	case 1:
		return signature + " " + results[0]
	default:
		return signature + " (" + strings.Join(results, ", ") + ")"
	}
}

func fieldTypes(fset *token.FileSet, fields *ast.FieldList) []string {
	if fields == nil {
		return nil
	}
	result := []string{}
	for _, field := range fields.List {
		count := len(field.Names)
		if count == 0 {
			count = 1
		}
		for range count {
			result = append(result, nodeString(fset, field.Type))
		}
	}
	return result
}

func collectTypes(fset *token.FileSet, declaration *ast.GenDecl, types map[string]Type) {
	if declaration.Tok != token.TYPE {
		return
	}
	for _, specification := range declaration.Specs {
		typeSpec, ok := specification.(*ast.TypeSpec)
		if !ok {
			continue
		}
		if structType, ok := typeSpec.Type.(*ast.StructType); ok {
			fields := make([]Field, 0, len(structType.Fields.List))
			for _, field := range structType.Fields.List {
				if len(field.Names) == 0 {
					continue
				}
				for _, name := range field.Names {
					tag, jsName := "", ""
					if field.Tag != nil {
						tag, _ = strconv.Unquote(field.Tag.Value)
						jsName = reflect.StructTag(tag).Get("jsbind")
					}
					fields = append(fields, Field{GoName: name.Name, JSName: jsName, Tag: tag, Type: nodeString(fset, field.Type)})
				}
			}
			sort.Slice(fields, func(i, j int) bool { return fields[i].GoName < fields[j].GoName })
			types[typeSpec.Name.Name] = Type{Kind: "struct", Fields: fields}
			continue
		}
		kind := "defined"
		if typeSpec.Assign.IsValid() {
			kind = "alias"
		}
		types[typeSpec.Name.Name] = Type{Kind: kind, Target: nodeString(fset, typeSpec.Type)}
	}
}

func stringLiteral(expression ast.Expr) (string, bool) {
	literal, ok := expression.(*ast.BasicLit)
	if !ok || literal.Kind != token.STRING {
		return "", false
	}
	value, err := strconv.Unquote(literal.Value)
	return value, err == nil
}

func fieldArity(fields *ast.FieldList) int {
	if fields == nil {
		return 0
	}
	count := 0
	for _, field := range fields.List {
		if len(field.Names) == 0 {
			count++
		} else {
			count += len(field.Names)
		}
	}
	return count
}

func nodeString(fset *token.FileSet, node any) string {
	var output strings.Builder
	if err := format.Node(&output, fset, node); err != nil {
		return "<unprintable>"
	}
	return output.String()
}

func sourceLocation(root string, fset *token.FileSet, position token.Pos) string {
	info := fset.PositionFor(position, false)
	relative, err := filepath.Rel(root, info.Filename)
	if err != nil {
		relative = info.Filename
	}
	return filepath.ToSlash(relative) + ":" + strconv.Itoa(info.Line)
}

func fingerprintDiceSource(diceDirectory string) (string, error) {
	files := []string{}
	err := filepath.WalkDir(diceDirectory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if strings.HasSuffix(entry.Name(), ".go") && !strings.HasSuffix(entry.Name(), "_test.go") {
			files = append(files, path)
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(files)
	hash := sha256.New()
	for _, file := range files {
		relative, err := filepath.Rel(diceDirectory, file)
		if err != nil {
			return "", err
		}
		contents, err := os.ReadFile(file)
		if err != nil {
			return "", err
		}
		_, _ = hash.Write([]byte(filepath.ToSlash(relative)))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write(contents)
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
