package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProbeDirectoryProtectsProduction(t *testing.T) {
	userDirectory := t.TempDir()
	production := filepath.Join(userDirectory, ".aut")
	if err := os.Mkdir(production, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(userDirectory, "alias")
	if err := os.Symlink(production, alias); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{production, filepath.Join(production, "new"), alias, filepath.Join(alias, "new")} {
		if _, err := probeDirectory(path, userDirectory); err == nil {
			t.Fatalf("accepted protected state path %q", path)
		}
	}
	if _, err := os.Stat(filepath.Join(production, "new")); !os.IsNotExist(err) {
		t.Fatal("validation changed the protected directory")
	}
	if _, err := probeDirectory(filepath.Join(userDirectory, "probe", "new"), userDirectory); err != nil {
		t.Fatal(err)
	}
}
