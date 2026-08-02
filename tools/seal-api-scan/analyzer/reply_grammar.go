package analyzer

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ReplyGrammar is the discriminant vocabulary observed in SealDice's reply
// parser/matcher and in sealwrapper's test-only strict checker. It is an
// audit input, not a second runtime parser.
type ReplyGrammar struct {
	CondTypes   []string `json:"condTypes"`
	MatchTypes  []string `json:"matchTypes"`
	MatchOps    []string `json:"matchOps"`
	ResultTypes []string `json:"resultTypes"`
}

// ReplyGrammarAudit keeps production and overlay observations separate so a
// report can explain exactly which side drifted.
type ReplyGrammarAudit struct {
	Production ReplyGrammar `json:"production"`
	Overlay    ReplyGrammar `json:"overlay"`
}

func addUnique(into map[string]struct{}, value string) {
	if value != "" {
		into[value] = struct{}{}
	}
}

func sortedValues(values map[string]struct{}) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

func receiverName(function *ast.FuncDecl) string {
	if function.Recv == nil || len(function.Recv.List) == 0 {
		return ""
	}
	var unwrap func(ast.Expr) string
	unwrap = func(expression ast.Expr) string {
		switch value := expression.(type) {
		case *ast.StarExpr:
			return unwrap(value.X)
		case *ast.Ident:
			return value.Name
		case *ast.IndexExpr:
			return unwrap(value.X)
		case *ast.IndexListExpr:
			return unwrap(value.X)
		default:
			return ""
		}
	}
	return unwrap(function.Recv.List[0].Type)
}

func mapValueType(expression ast.Expr) string {
	mapType, ok := expression.(*ast.MapType)
	if !ok {
		return ""
	}
	if _, ok := mapType.Key.(*ast.Ident); !ok {
		return ""
	}
	return expressionName(mapType.Value)
}

func expressionName(expression ast.Expr) string {
	switch value := expression.(type) {
	case *ast.Ident:
		return value.Name
	case *ast.SelectorExpr:
		left := expressionName(value.X)
		if left == "" {
			return value.Sel.Name
		}
		return left + "." + value.Sel.Name
	case *ast.StarExpr:
		return "*" + expressionName(value.X)
	default:
		return ""
	}
}

func reflectTypeTarget(expression ast.Expr) string {
	call, ok := expression.(*ast.CallExpr)
	if !ok || len(call.Args) != 1 {
		return ""
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != "TypeOf" || expressionName(selector.X) != "reflect" {
		return ""
	}
	argument := call.Args[0]
	if composite, ok := argument.(*ast.CompositeLit); ok {
		return expressionName(composite.Type)
	}
	return expressionName(argument)
}

func collectMapGrammar(literal *ast.CompositeLit, cond, result, match map[string]struct{}) {
	mapKind := mapValueType(literal.Type)
	for _, element := range literal.Elts {
		keyValue, ok := element.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		key, ok := stringLiteral(keyValue.Key)
		if !ok {
			continue
		}
		if mapKind == "reflect.Type" {
			target := reflectTypeTarget(keyValue.Value)
			switch {
			case strings.Contains(target, "ReplyCondition"):
				addUnique(cond, key)
			case strings.Contains(target, "ReplyResult"):
				addUnique(result, key)
			}
		}
		// The overlay uses map[string]bool for its explicitly reviewed matcher
		// set. Restrict this to match* keys so unrelated boolean maps cannot
		// accidentally become part of the grammar.
		if mapKind == "bool" && strings.HasPrefix(key, "match") {
			addUnique(match, key)
		}
	}
}

func collectFunctionLiterals(function *ast.FuncDecl, values map[string]struct{}) {
	if function.Body == nil {
		return
	}
	ast.Inspect(function.Body, func(node ast.Node) bool {
		caseClause, ok := node.(*ast.CaseClause)
		if !ok {
			return true
		}
		for _, expression := range caseClause.List {
			if value, ok := stringLiteral(expression); ok {
				addUnique(values, value)
			}
		}
		return true
	})
}

func collectComparisonStringLiterals(function *ast.FuncDecl, values map[string]struct{}) {
	if function.Body == nil {
		return
	}
	ast.Inspect(function.Body, func(node ast.Node) bool {
		binary, ok := node.(*ast.BinaryExpr)
		if !ok || (binary.Op != token.EQL && binary.Op != token.NEQ) {
			return true
		}
		for _, expression := range []ast.Expr{binary.X, binary.Y} {
			if literal, ok := expression.(*ast.BasicLit); ok && literal.Kind == token.STRING {
				if value, err := strconv.Unquote(literal.Value); err == nil {
					// `matchRegex` is a matcher discriminant, not a
					// text-length match operation. Keep the two vocabularies
					// separate when both occur in the same checker function.
					if !strings.HasPrefix(value, "match") {
						addUnique(values, value)
					}
				}
			}
		}
		return true
	})
}

func scanGrammarFile(file string, includeOverlay bool, grammar *ReplyGrammar) error {
	set := token.NewFileSet()
	parsed, err := parser.ParseFile(set, file, nil, parser.ParseComments)
	if err != nil {
		return fmt.Errorf("parse %s: %w", file, err)
	}
	cond := map[string]struct{}{}
	match := map[string]struct{}{}
	ops := map[string]struct{}{}
	result := map[string]struct{}{}
	for _, declaration := range parsed.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok {
			receiver := receiverName(function)
			switch receiver {
			case "ReplyConditionTextMatch":
				collectFunctionLiterals(function, match)
			case "ReplyConditionTextLenLimit":
				collectComparisonStringLiterals(function, ops)
			}
			if includeOverlay {
				switch function.Name.Name {
				case "sealwrapperCheckReplyConditions":
					collectFunctionLiterals(function, cond)
					collectComparisonStringLiterals(function, ops)
				case "sealwrapperCheckReplyResult":
					collectFunctionLiterals(function, result)
				}
			}
		}
	}
	ast.Inspect(parsed, func(node ast.Node) bool {
		literal, ok := node.(*ast.CompositeLit)
		if !ok {
			return true
		}
		collectMapGrammar(literal, cond, result, match)
		return true
	})
	grammar.CondTypes = append(grammar.CondTypes, sortedValues(cond)...)
	grammar.MatchTypes = append(grammar.MatchTypes, sortedValues(match)...)
	grammar.MatchOps = append(grammar.MatchOps, sortedValues(ops)...)
	grammar.ResultTypes = append(grammar.ResultTypes, sortedValues(result)...)
	return nil
}

func normalizeGrammar(grammar *ReplyGrammar) {
	for _, values := range []*[]string{&grammar.CondTypes, &grammar.MatchTypes, &grammar.MatchOps, &grammar.ResultTypes} {
		seen := map[string]struct{}{}
		for _, value := range *values {
			addUnique(seen, value)
		}
		*values = sortedValues(seen)
	}
}

// ScanReplyGrammar reads production reply logic and (optionally) the applied
// test-only overlay. It never executes either source and never writes files.
func ScanReplyGrammar(core, overlay string) (ReplyGrammarAudit, error) {
	production := ReplyGrammar{}
	diceDirectory := filepath.Join(core, "dice")
	entries := []string{}
	err := filepath.WalkDir(diceDirectory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}
		entries = append(entries, path)
		return nil
	})
	if err != nil {
		return ReplyGrammarAudit{}, err
	}
	sort.Strings(entries)
	for _, file := range entries {
		if err := scanGrammarFile(file, false, &production); err != nil {
			return ReplyGrammarAudit{}, err
		}
	}
	normalizeGrammar(&production)
	if len(production.CondTypes) == 0 || len(production.ResultTypes) == 0 {
		return ReplyGrammarAudit{}, fmt.Errorf("reply grammar was not found in production core")
	}
	overlayGrammar := ReplyGrammar{}
	if overlay != "" {
		if err := scanGrammarFile(overlay, true, &overlayGrammar); err != nil {
			return ReplyGrammarAudit{}, err
		}
		normalizeGrammar(&overlayGrammar)
	}
	return ReplyGrammarAudit{Production: production, Overlay: overlayGrammar}, nil
}
