import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { UiStateService } from './ui-state.service';

describe('UiStateService', () => {
  let service: UiStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(UiStateService);
  });

  describe('initial state', () => {
    it('sidebarOpen defaults to false', () => {
      expect(service.sidebarOpen()).toBe(false);
    });

    it('memoryOpen defaults to false', () => {
      expect(service.memoryOpen()).toBe(false);
    });
  });

  describe('toggleSidebar', () => {
    it('flips sidebarOpen from false to true', () => {
      service.toggleSidebar();
      expect(service.sidebarOpen()).toBe(true);
    });

    it('flips sidebarOpen from true back to false', () => {
      service.toggleSidebar();
      service.toggleSidebar();
      expect(service.sidebarOpen()).toBe(false);
    });

    it('does not affect memoryOpen', () => {
      service.toggleSidebar();
      expect(service.memoryOpen()).toBe(false);
    });
  });

  describe('toggleMemory', () => {
    it('flips memoryOpen from false to true', () => {
      service.toggleMemory();
      expect(service.memoryOpen()).toBe(true);
    });

    it('flips memoryOpen from true back to false', () => {
      service.toggleMemory();
      service.toggleMemory();
      expect(service.memoryOpen()).toBe(false);
    });

    it('does not affect sidebarOpen', () => {
      service.toggleMemory();
      expect(service.sidebarOpen()).toBe(false);
    });
  });

  describe('closeSidebar', () => {
    it('sets sidebarOpen to false when open', () => {
      service.toggleSidebar();
      service.closeSidebar();
      expect(service.sidebarOpen()).toBe(false);
    });

    it('leaves sidebarOpen false when already closed', () => {
      service.closeSidebar();
      expect(service.sidebarOpen()).toBe(false);
    });
  });

  describe('closeMemory', () => {
    it('sets memoryOpen to false when open', () => {
      service.toggleMemory();
      service.closeMemory();
      expect(service.memoryOpen()).toBe(false);
    });

    it('leaves memoryOpen false when already closed', () => {
      service.closeMemory();
      expect(service.memoryOpen()).toBe(false);
    });
  });

  describe('singleton scoping', () => {
    it('returns the same instance across inject() calls', () => {
      const second = TestBed.inject(UiStateService);
      expect(second).toBe(service);
    });
  });
});
