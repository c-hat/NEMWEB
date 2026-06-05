export type DataSource = 'static' | 'api';

const rawSource = process.env.NEXT_PUBLIC_DATA_SOURCE;

export const DATA_SOURCE: DataSource = rawSource === 'api' ? 'api' : 'static';

export const USE_API_DATA = DATA_SOURCE === 'api';
