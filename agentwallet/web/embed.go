// Package web embeds the chat UI served at "/".
package web

import "embed"

//go:embed all:static
var Static embed.FS
