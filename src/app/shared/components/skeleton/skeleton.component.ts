import { Component, Input } from '@angular/core';

/**
 * Reusable skeleton (shimmer) loading placeholder.
 * ডেটা লোড হওয়ার সময় স্পিনারের বদলে কনটেন্টের আকৃতি দেখায়।
 *
 * Variants:
 *  - table  : header + rows with columns (customer, loan, receipt lists)
 *  - cards  : KPI / summary card grid
 *  - detail : summary cards + ledger table (loan detail page)
 *  - form   : labelled input fields in a grid
 *  - list   : simple stacked rows (modal sections, small panels)
 *  - field  : single input-sized bar (dropdown loading)
 */
@Component({
  selector: 'app-skeleton',
  standalone: true,
  templateUrl: './skeleton.component.html',
  styleUrl: './skeleton.component.scss'
})
export class SkeletonComponent {
  @Input() variant: 'table' | 'cards' | 'detail' | 'form' | 'list' | 'field' = 'table';
  @Input() rows = 6;
  @Input() columns = 5;
  @Input() cards = 4;
  /** Screen-reader label */
  @Input() label = 'লোড হচ্ছে...';

  range(n: number): number[] {
    return Array.from({ length: n }, (_, i) => i);
  }

  /** Vary line widths so the placeholder looks like real content */
  cellWidth(row: number, col: number): string {
    const widths = [85, 60, 75, 50, 90, 65, 70, 55];
    return widths[(row * 3 + col) % widths.length] + '%';
  }
}
