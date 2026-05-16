package protocol

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
)

const Version = 1

type Start struct {
	V      int      `json:"v"`
	Type   string   `json:"type"`
	Root   string   `json:"root"`
	Ignore []string `json:"ignore"`
	Filter []string `json:"filter"`
	Mode   string   `json:"mode"`
	Dirs   []string `json:"dirs"`
}

type Ready struct {
	V       int    `json:"v"`
	Type    string `json:"type"`
	Watched int    `json:"watched"`
	Ignored int    `json:"ignored"`
}

type Event struct {
	V     int    `json:"v"`
	Type  string `json:"type"`
	Path  string `json:"path"`
	Event string `json:"event"`
}

type Error struct {
	V     int    `json:"v"`
	Type  string `json:"type"`
	Stage string `json:"stage"`
	Fatal bool   `json:"fatal"`
	Error string `json:"error"`
}

type Decoder struct {
	r *bufio.Reader
}

func NewDecoder(r io.Reader) *Decoder {
	return &Decoder{r: bufio.NewReader(r)}
}

func (d *Decoder) Decode() (Start, error) {
	line, err := d.r.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return Start{}, err
	}

	var msg Start
	if err := json.Unmarshal(line, &msg); err != nil {
		return Start{}, err
	}
	if msg.V != Version {
		return Start{}, errors.New("unsupported protocol version")
	}
	if msg.Type != "start" && msg.Type != "sync" {
		return Start{}, errors.New("invalid message type")
	}
	if msg.Type == "start" && msg.Mode == "" {
		msg.Mode = "full"
	}
	return msg, nil
}

func Decode(r io.Reader) (Start, error) {
	return NewDecoder(r).Decode()
}

func Encode(w io.Writer, msg any) error {
	body, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	_, err = w.Write(append(body, '\n'))
	return err
}
