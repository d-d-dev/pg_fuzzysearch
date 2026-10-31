CC ?= cc
CFLAGS ?= -O2 -g -std=c11 -Wall -Wextra -Wpedantic
CPPFLAGS ?= -Isrc
LDFLAGS ?=
LDLIBS ?= -lm

BUILD := build
CORE_OBJS := $(BUILD)/fuzzy_core.o $(BUILD)/normalize.o $(BUILD)/tables.o
CLI := $(BUILD)/fuzzy_cli

.PHONY: all clean test test-phase1 test-phase2 test-phase3 bench-phase3 tables pg pg-install install

all: $(CLI)

$(BUILD):
	mkdir -p $(BUILD)

$(BUILD)/%.o: src/%.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(BUILD)/fuzzy_cli.o: tools/fuzzy_cli.c | $(BUILD)
	$(CC) $(CPPFLAGS) $(CFLAGS) -c $< -o $@

$(CLI): $(CORE_OBJS) $(BUILD)/fuzzy_cli.o
	$(CC) $(LDFLAGS) $^ $(LDLIBS) -o $@

tables: src/tables.c src/tables.h

src/tables.c src/tables.h: tools/gen_tables.mjs
	node tools/gen_tables.mjs

test-phase1: $(CLI)
	node test/phase1/run.mjs

test-phase2: $(CLI) pg
	node test/phase2/run.mjs

test-phase3: $(CLI) pg
	node test/phase3/run.mjs

bench-phase3: $(CLI) pg
	node test/phase3/bench.mjs

test: test-phase1 test-phase2 test-phase3

pg:
	$(MAKE) -C pg

pg-install:
	$(MAKE) -C pg install

install: pg-install

clean:
	rm -rf $(BUILD)
	$(MAKE) -C pg clean
