package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	_ "image/png"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/leaanthony/dmg/dsstore"
	"github.com/leaanthony/dmg/hfsplus"
	"github.com/leaanthony/dmg/icns"
	"github.com/leaanthony/dmg/udif"
)

type manifestEntry struct {
	Path   string `json:"path"`
	Type   string `json:"type"`
	Source string `json:"source"`
	Mode   uint16 `json:"mode"`
	Target string `json:"target"`
}

type manifest struct {
	Entries []manifestEntry `json:"entries"`
}

func validPath(value string) bool {
	if value == "" || value == "." || path.IsAbs(value) || path.Clean(value) != value {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." || strings.ContainsAny(part, "\\:\x00") {
			return false
		}
	}
	return true
}

func buildTree(entries []manifestEntry, volume *hfsplus.Volume) error {
	nodes := map[string]*hfsplus.Entry{}
	explicit := map[string]bool{}
	folded := map[string]string{}
	for _, entry := range entries {
		if !validPath(entry.Path) || entry.Mode & ^uint16(0777) != 0 {
			return fmt.Errorf("invalid path or permissions for %q", entry.Path)
		}
		if explicit[entry.Path] {
			return fmt.Errorf("duplicate manifest path %q", entry.Path)
		}
		explicit[entry.Path] = true
		for _, char := range entry.Path {
			if char > 127 {
				volume.CaseSensitive = true
			}
		}
		parts := strings.Split(entry.Path, "/")
		for index := range parts {
			prefix := strings.Join(parts[:index+1], "/")
			fold := strings.ToLower(prefix)
			if other, ok := folded[fold]; ok && other != prefix {
				return fmt.Errorf("case-colliding paths %q and %q", other, prefix)
			}
			folded[fold] = prefix
		}
	}
	var ensureDirectory func(string) (*hfsplus.Entry, error)
	ensureDirectory = func(value string) (*hfsplus.Entry, error) {
		if value == "." {
			return nil, nil
		}
		if node, ok := nodes[value]; ok {
			if node.Kind != hfsplus.KindDir {
				return nil, fmt.Errorf("parent path is not a directory: %q", value)
			}
			return node, nil
		}
		parent, err := ensureDirectory(path.Dir(value))
		if err != nil {
			return nil, err
		}
		node := &hfsplus.Entry{Name: path.Base(value), Kind: hfsplus.KindDir, Mode: 0755}
		nodes[value] = node
		if parent == nil {
			volume.Children = append(volume.Children, node)
		} else {
			parent.Children = append(parent.Children, node)
		}
		return node, nil
	}

	for _, entry := range entries {
		if entry.Type == "directory" {
			node, err := ensureDirectory(entry.Path)
			if err != nil {
				return err
			}
			node.Mode = entry.Mode
			continue
		}
		parent, err := ensureDirectory(path.Dir(entry.Path))
		if err != nil {
			return err
		}
		if _, exists := nodes[entry.Path]; exists {
			return fmt.Errorf("file replaces a directory: %q", entry.Path)
		}
		node := &hfsplus.Entry{Name: path.Base(entry.Path), Mode: entry.Mode}
		switch entry.Type {
		case "file":
			info, err := os.Lstat(entry.Source)
			if err != nil {
				return fmt.Errorf("read source for %q: %w", entry.Path, err)
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("source is not a regular file: %q", entry.Source)
			}
			node.Kind = hfsplus.KindFile
			node.Data, err = os.ReadFile(entry.Source)
			if err != nil {
				return err
			}
		case "symlink":
			if entry.Target == "" || path.IsAbs(entry.Target) ||
				strings.ContainsAny(entry.Target, "\\:\x00") {
				return fmt.Errorf("invalid link target for %q", entry.Path)
			}
			resolved := path.Clean(path.Join(path.Dir(entry.Path), entry.Target))
			root := strings.Split(entry.Path, "/")[0]
			if resolved != root && !strings.HasPrefix(resolved, root+"/") {
				return fmt.Errorf("link escapes the application: %q", entry.Path)
			}
			node.Kind = hfsplus.KindSymlink
			node.Target = entry.Target
		default:
			return fmt.Errorf("unknown entry type %q", entry.Type)
		}
		nodes[entry.Path] = node
		if parent == nil {
			volume.Children = append(volume.Children, node)
		} else {
			parent.Children = append(parent.Children, node)
		}
	}
	if len(volume.Children) != 1 || !strings.HasSuffix(volume.Children[0].Name, ".app") {
		return fmt.Errorf("expected exactly one application bundle")
	}
	sortTree(volume.Children)
	return nil
}

func sortTree(entries []*hfsplus.Entry) {
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	for _, entry := range entries {
		if entry.Kind == hfsplus.KindDir {
			sortTree(entry.Children)
		}
	}
}

func decorate(volume *hfsplus.Volume, iconPath string) error {
	appName := volume.Children[0].Name
	volume.Children = append(volume.Children, &hfsplus.Entry{
		Name: "Applications", Kind: hfsplus.KindSymlink, Target: "/Applications", Mode: 0777,
	})
	store := dsstore.New()
	store.SetWindowSettings(dsstore.WindowSettings{Top: 160, Left: 200, Bottom: 540, Right: 740})
	store.SetIconViewOptions(dsstore.IconViewOptions{
		IconSize: 128, TextSize: 12, GridSpace: 100, LabelOnBottom: true,
		BackgroundType: dsstore.BackgroundColor, BackgroundRed: 0.13, BackgroundGreen: 0.12, BackgroundBlue: 0.21,
	})
	store.SetIconPosition(appName, 150, 170)
	store.SetIconPosition("Applications", 390, 170)
	var data bytes.Buffer
	if err := store.WriteTo(&data); err != nil {
		return err
	}
	volume.Children = append(volume.Children, &hfsplus.Entry{
		Name: ".DS_Store", Kind: hfsplus.KindFile, Data: data.Bytes(), Mode: 0644,
	})
	if iconPath != "" {
		file, err := os.Open(iconPath)
		if err != nil {
			return err
		}
		img, _, err := image.Decode(file)
		file.Close()
		if err != nil {
			return err
		}
		var icon bytes.Buffer
		if err := icns.Encode(&icon, img); err != nil {
			return err
		}
		volume.Children = append(volume.Children, &hfsplus.Entry{
			Name: ".VolumeIcon.icns", Kind: hfsplus.KindFile, Data: icon.Bytes(), Mode: 0644,
		})
		volume.RootFinderFlags = 0x0400
	}
	return nil
}

func run() error {
	if len(os.Args) < 4 || len(os.Args) > 5 {
		return fmt.Errorf("usage: windows-dmg manifest.json output.dmg volumeName [icon.png]")
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		return err
	}
	var input manifest
	if err := json.Unmarshal(data, &input); err != nil {
		return err
	}
	volume := &hfsplus.Volume{Name: os.Args[3], CreatedAt: time.Now().UTC()}
	if err := buildTree(input.Entries, volume); err != nil {
		return err
	}
	icon := ""
	if len(os.Args) == 5 {
		icon = os.Args[4]
	}
	if err := decorate(volume, icon); err != nil {
		return err
	}
	fmt.Printf("Building HFS+ image from %d application entries.\n", len(input.Entries))
	raw, err := hfsplus.Build(volume)
	if err != nil {
		return err
	}
	output := os.Args[2]
	if err := os.MkdirAll(filepath.Dir(output), 0755); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(output), ".noteject-dmg-*")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	fmt.Printf("Compressing %d bytes into UDZO.\n", len(raw))
	if err := udif.Build(temp, raw, "whole disk (Apple_HFS : 0)"); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(temp.Name(), output); err != nil {
		return err
	}
	fmt.Printf("Wrote %s\n", output)
	return nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
