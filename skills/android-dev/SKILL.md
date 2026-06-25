---
name: android-dev
description: "Android development via emulator: build, run, inspect UI."
trigger: "working with Android apps or emulator"
version: 1.0.0
author: August Proxy
license: MIT
---

# Android Development

## Overview

Build, run, and test Android applications using the Android Emulator. This skill covers project creation, building, launching, UI inspection, and basic automation.

> **Prerequisites:** This skill assumes Android Emulator MCP tools are configured in August Proxy. Without these tools, follow the workflow steps manually using Android Studio / command-line tools.

## Workflow

### 1. Environment Check

Verify the development environment is ready:
- Android SDK installed
- Emulator or device available
- Gradle wrapper present in the project

### 2. Discover or Create Project

- For existing projects: identify the project structure (build.gradle, app module, etc.)
- For new projects: create with the appropriate package name, SDK versions, and project structure

### 3. Build

Build the project:
- Assemble the debug variant
- Resolve any build errors (missing dependencies, SDK version mismatches, etc.)
- Verify the APK/AAB was produced

### 4. Launch

Deploy to an emulator or connected device:
- Start the emulator if needed
- Install the APK
- Launch the main activity

### 5. Verify

- Take a screenshot to verify the UI rendered correctly
- Check `logcat` output for errors or crashes
- Verify the expected behavior is working

### 6. UI Automation (Optional)

For automated interaction:
- Describe the current UI state
- Tap elements by their coordinates or content description
- Type text into input fields
- Swipe or perform gestures
- Verify the resulting UI state

## Common Tasks

| Task | Approach |
|------|----------|
| Build and run | Build debug APK, install, launch activity |
| Check logs | Read logcat output filtered by app package |
| Screenshot | Capture and display current screen |
| UI interaction | Describe UI, resolve element, tap/type/swipe |
