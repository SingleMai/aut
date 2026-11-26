package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// Do not silently reuse credentials or login behavior from another Tailscale setup.
var identityEnvironment = []string{
	"TS_AUTHKEY", "TS_AUTH_KEY", "TS_CLIENT_SECRET", "TS_CLIENT_ID",
	"TS_ID_TOKEN", "TS_AUDIENCE", "TSNET_FORCE_LOGIN",
}

// canonicalPath resolves existing ancestors before a new directory is created.
// A dangling symlink is an error, never an invitation to create its target.
func canonicalPath(path string) (string, error) {
	if _, err := os.Lstat(path); err == nil {
		return filepath.EvalSymlinks(path)
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	parent, err := canonicalPath(filepath.Dir(path))
	if err != nil {
		return "", err
	}
	return filepath.Join(parent, filepath.Base(path)), nil
}

func probeDirectory(path, userDirectory string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	absolute, err = canonicalPath(absolute)
	if err != nil {
		return "", err
	}
	production, err := canonicalPath(filepath.Join(userDirectory, ".aut"))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(production, absolute)
	if err != nil || (relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))) {
		return "", errors.New("probe state must be outside the production .aut directory, including symlink targets")
	}
	return absolute, nil
}
