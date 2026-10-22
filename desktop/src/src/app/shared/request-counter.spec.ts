import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { onRequestCounter } from './request-counter';

describe('onRequestCounter', () => {
  let calls: number;
  const counter = signal(0);

  beforeEach(() => {
    calls = 0;
    counter.set(0);
    TestBed.runInInjectionContext(() => onRequestCounter(counter, () => (calls += 1)));
  });

  it('does not fire for the value it first observes, even a non-zero one', () => {
    counter.set(5);
    TestBed.tick();
    expect(calls).toBe(0);
  });

  it('fires once per later change', () => {
    TestBed.tick();
    counter.set(1);
    TestBed.tick();
    counter.set(2);
    TestBed.tick();
    expect(calls).toBe(2);
  });

  it('does not fire when the counter is set to the value it already has', () => {
    TestBed.tick();
    counter.set(0);
    TestBed.tick();
    expect(calls).toBe(0);
  });
});
