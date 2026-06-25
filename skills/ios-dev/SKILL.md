---
name: ios-dev
description: "iOS development via simulator: build, run, inspect UI."
category: platform
trigger: "working with iOS apps or simulator"
version: 1.0.0
author: August Proxy
license: MIT
---

# iOS Development

## Overview

Build, run, and test iOS applications using the iOS Simulator. This skill covers project creation, building, launching, UI inspection, and basic automation.

> **Prerequisites:** This skill requires Xcode and `simctl` (part of Xcode command-line tools) on macOS. If iOS Simulator MCP tools are configured in August Proxy, those will be used for automation.

## Workflow

### 1. Environment Check

Verify the development environment is ready:
- Xcode installed (`xcode-select -p`)
- Simulator runtime available (`xcrun simctl list runtimes`)
- At least one simulator device available (`xcrun simctl list devices`)

### 2. Discover or Create Project

- For existing projects: identify the Xcode project or workspace structure
- For new projects: create with the appropriate bundle identifier, deployment target, and project structure

### 3. Build

Build the project for the simulator:
- Use the Debug configuration
- Resolve any build errors (missing dependencies, deployment target mismatches, etc.)
- Verify the .app bundle was produced

### 4. Launch

Deploy to a simulator:
- Boot the simulator if needed (`xcrun simctl boot <udid>`)
- Install and launch the app (`xcrun simctl launch <udid> <bundle-id>`)
- Open the Simulator app to view if needed

### 5. Verify

- Take a screenshot to verify the UI rendered correctly
- Check system logs for errors or crashes
- Verify the expected behavior is working

### 6. UI Automation (Optional)

For automated interaction:
- Tap elements by coordinates
- Type text
- Swipe or perform gestures
- Verify app state through screenshots

## Common Tasks

| Task | Approach |
|------|----------|
| Build and run | Build Debug for simulator, install, launch bundle ID |
| Check logs | Read system log filtered by process |
| Screenshot | Capture and display current simulator screen |
| UI interaction | Describe UI, tap/type/swipe via coordinates |
