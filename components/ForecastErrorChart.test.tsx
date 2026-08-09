import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fixtureDayData } from '@/__fixtures__/dayData';
import ForecastErrorChart from './ForecastErrorChart';

describe('ForecastErrorChart', () => {
  it('renders the chart title', () => {
    render(<ForecastErrorChart regions={fixtureDayData.regions} region="NSW1" />);

    expect(
      screen.getByRole('region', { name: 'NSW forecast error decomposition chart' }),
    ).toBeInTheDocument();
    expect(screen.getByText('NSW — Forecast Error')).toBeInTheDocument();
  });

  it('renders an empty state when no complete intervals exist', () => {
    render(
      <ForecastErrorChart
        region="NSW1"
        regions={{
          ...fixtureDayData.regions,
          NSW1: {
            demand: { intervals: [], poe10: [], poe50: [], poe90: [], actual: [] },
            rooftopPv: { intervals: [], poe10: [], poe50: [], poe90: [], actual: [] },
          },
        }}
      />,
    );

    expect(screen.getByText('No chart data available.')).toBeInTheDocument();
  });

  it('renders regional and NEM chart regions', () => {
    const { rerender } = render(<ForecastErrorChart regions={fixtureDayData.regions} region="VIC1" />);
    expect(
      screen.getByRole('region', { name: 'VIC forecast error decomposition chart' }),
    ).toBeInTheDocument();

    rerender(<ForecastErrorChart regions={fixtureDayData.regions} region="NEM" />);
    expect(
      screen.getByRole('region', { name: 'NEM forecast error decomposition chart' }),
    ).toBeInTheDocument();
  });
});
