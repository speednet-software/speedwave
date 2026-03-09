/**
 * Angular TestBed initialization for Vitest.
 *
 * When tests are run via `ng test`, the @angular/build:unit-test builder
 * generates an `init-testbed.js` setup file automatically. This file
 * replicates that initialization so `npx vitest run` also works.
 */
import { NgModule } from '@angular/core';
import { getTestBed } from '@angular/core/testing';
import { BrowserTestingModule, platformBrowserTesting } from '@angular/platform-browser/testing';
import { afterEach, beforeEach } from 'vitest';

// Cleanup hooks matching Angular's internal test_hooks.ts behavior.
// See: https://github.com/angular/angular/blob/main/packages/core/testing/src/test_hooks.ts
beforeEach(() => {
  // TestBed auto-teardown handles cleanup via afterEach below.
});

afterEach(() => {
  getTestBed().resetTestingModule();
});

const ANGULAR_TESTBED_SETUP = Symbol.for('@angular/cli/testbed-setup');
if (!(globalThis as Record<symbol, boolean>)[ANGULAR_TESTBED_SETUP]) {
  (globalThis as Record<symbol, boolean>)[ANGULAR_TESTBED_SETUP] = true;

  @NgModule({
    providers: [],
  })
  class TestModule {}

  getTestBed().initTestEnvironment([BrowserTestingModule, TestModule], platformBrowserTesting(), {
    errorOnUnknownElements: true,
    errorOnUnknownProperties: true,
  });
}
