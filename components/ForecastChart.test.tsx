import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fixtureMetric } from '@/__fixtures__/dayData';
import ForecastChart from './ForecastChart';

describe('ForecastChart', () => {
  it('renders the chart title and accessible region label', () => {
    render(<ForecastChart title="NEM - Demand" unit="MW" metric={fixtureMetric} />);

    expect(screen.getByRole('region', { name: 'NEM - Demand forecast chart' })).toBeInTheDocument();
    expect(screen.getByText('NEM - Demand')).toBeInTheDocument();
    expect(screen.getByText('MW')).toBeInTheDocument();
  });

  it('renders the LIVE badge when live data is fresh', () => {
    render(
      <ForecastChart
        title="NEM - Demand"
        unit="MW"
        metric={fixtureMetric}
        live
        lastUpdated={Date.now()}
      />,
    );

    expect(screen.getByText(/Live · updated/)).toBeInTheDocument();
  });

  it('renders the STALE badge when live data is stale', () => {
    render(
      <ForecastChart
        title="NEM - Demand"
        unit="MW"
        metric={fixtureMetric}
        live
        stale
        lastUpdated={Date.now() - 30 * 60_000}
      />,
    );

    expect(screen.getByText(/Stale · last update/)).toBeInTheDocument();
  });

  it('shows an empty state for metrics with no intervals', () => {
    render(
      <ForecastChart
        title="NEM - Demand"
        unit="MW"
        metric={{ intervals: [], poe10: [], poe50: [], poe90: [], actual: [] }}
      />,
    );

    expect(screen.getByText('No chart data available.')).toBeInTheDocument();
  });
});
