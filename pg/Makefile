EXTENSION = pg_fuzzysearch
MODULE_big = pg_fuzzysearch
OBJS = ../src/fuzzy_core.o ../src/normalize.o ../src/tables.o ../src/pg_fuzzysearch.o
DATA = ../sql/pg_fuzzysearch--0.1.0.sql
PG_CPPFLAGS = -I../src
SHLIB_LINK += -lm

PG_CONFIG ?= pg_config
PGXS := $(shell $(PG_CONFIG) --pgxs)
include $(PGXS)

# Fedora's pg_config reports RPM hardening specs that are not installed in this
# environment.  Keep the extension build portable and use a clean FP model so
# the ported score arithmetic stays close to JavaScript.
override CFLAGS := -O2 -g -std=c11 -Wall -Wextra -Wno-unused-parameter \
	-fno-strict-aliasing -fwrapv -fexcess-precision=standard \
	-fno-fast-math -ffp-contract=off -fPIC
override LDFLAGS :=
