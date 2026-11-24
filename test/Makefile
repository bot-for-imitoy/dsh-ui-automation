# Test fixtures and runners
#
#   make fixtures   compile the Qt6 / GTK3 control panels
#   make matrix     operation matrix (node test/integration.mjs)
#   make reliability 30 attempts per operation

CXX ?= g++
CC ?= gcc
QT_CFLAGS := $(shell pkg-config --cflags --libs Qt6Widgets)
GTK3_CFLAGS := $(shell pkg-config --cflags --libs gtk+-3.0)

.PHONY: fixtures matrix reliability clean

fixtures: fixtures/panel_qt fixtures/panel_gtk3

fixtures/panel_qt: fixtures/panel_qt.cpp
	$(CXX) -fPIC -O1 $< -o $@ $(QT_CFLAGS)

fixtures/panel_gtk3: fixtures/panel_gtk3.c
	$(CC) -O1 $< -o $@ $(GTK3_CFLAGS)

matrix:
	node integration.mjs

reliability:
	node reliability.mjs

clean:
	rm -f fixtures/panel_qt fixtures/panel_gtk3
	rm -rf out
