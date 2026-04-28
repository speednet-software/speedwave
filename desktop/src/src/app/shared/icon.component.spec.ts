import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IconComponent, type IconName } from './icon.component';

const ICON_NAMES: readonly IconName[] = [
  'menu',
  'menu-alt',
  'plus',
  'x',
  'brain',
  'book',
  'chevron-right',
  'chevron-down',
  'alert-triangle',
  'git-branch',
  'message-circle',
  'messages-square',
  'code',
  'cube',
  'settings',
  'document',
  'refresh',
];

const SHAPE_SELECTORS = ['path', 'line', 'polygon', 'polyline', 'circle'];

@Component({
  template: `<app-icon [name]="name()" [strokeWidth]="strokeWidth()" />`,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class HostComponent {
  readonly name = signal<IconName>('menu');
  readonly strokeWidth = signal<number>(1.75);
}

function querySvg(host: HTMLElement): SVGElement {
  const svg = host.querySelector('svg');
  if (!svg) throw new Error('svg not rendered');
  return svg;
}

function hasShape(svg: SVGElement): boolean {
  return SHAPE_SELECTORS.some((sel) => svg.querySelector(sel) !== null);
}

describe('IconComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(HostComponent);
  });

  for (const name of ICON_NAMES) {
    it(`renders an svg shape for "${name}"`, () => {
      fixture.componentInstance.name.set(name);
      fixture.detectChanges();

      const svg = querySvg(fixture.nativeElement as HTMLElement);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(hasShape(svg)).toBe(true);
    });
  }

  it('defaults stroke-width to 1.75', () => {
    fixture.detectChanges();

    const svg = querySvg(fixture.nativeElement as HTMLElement);
    expect(svg.getAttribute('stroke-width')).toBe('1.75');
  });

  it('propagates custom strokeWidth=2 to attr.stroke-width', () => {
    fixture.componentInstance.strokeWidth.set(2);
    fixture.detectChanges();

    const svg = querySvg(fixture.nativeElement as HTMLElement);
    expect(svg.getAttribute('stroke-width')).toBe('2');
  });

  it('always sets aria-hidden="true" on the svg', () => {
    fixture.componentInstance.name.set('settings');
    fixture.detectChanges();

    const svg = querySvg(fixture.nativeElement as HTMLElement);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });
});
