import { describe, it, expect, beforeEach } from 'vitest';
import { Component, OnDestroy, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { RecreateOnDirective } from './recreate-on.directive';

let created = 0;
let destroyed = 0;

@Component({
  selector: 'app-keyed-child',
  template: `<span>{{ note }}</span>`,
})
class KeyedChildComponent implements OnDestroy {
  note = '';

  constructor() {
    created++;
  }

  ngOnDestroy(): void {
    destroyed++;
  }
}

@Component({
  imports: [RecreateOnDirective, KeyedChildComponent],
  template: `<app-keyed-child *appRecreateOn="key()" />`,
})
class HostComponent {
  readonly key = signal<string | null>(null);
}

describe('RecreateOnDirective', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    created = 0;
    destroyed = 0;
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
  });

  function child(): KeyedChildComponent {
    return fixture.debugElement.query(By.directive(KeyedChildComponent))
      .componentInstance as KeyedChildComponent;
  }

  it('renders the template once for the first key, including a null one', () => {
    fixture.detectChanges();

    expect(created).toBe(1);
    expect(child()).toBeTruthy();
  });

  it('recreates the view when the key changes, dropping the old view state', () => {
    fixture.detectChanges();
    const before = child();
    before.note = 'typed for the first key';

    fixture.componentInstance.key.set('second');
    fixture.detectChanges();

    expect(child()).not.toBe(before);
    expect(child().note).toBe('');
    expect(created).toBe(2);
    expect(destroyed).toBe(1);
  });

  it('keeps the view while the key stays the same', () => {
    fixture.componentInstance.key.set('same');
    fixture.detectChanges();
    const before = child();

    fixture.componentInstance.key.set('same');
    fixture.detectChanges();

    expect(child()).toBe(before);
    expect(created).toBe(1);
  });
});
