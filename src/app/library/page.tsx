import { redirect } from 'next/navigation';
import LibraryIndex from './library-index';

export default async function LibraryPage({ searchParams }: { searchParams: Promise<{ play?: string | string[] }> }) {
  const { play } = await searchParams;
  if (typeof play === 'string' && play) redirect(`/library/play/${encodeURIComponent(play)}`);
  return <LibraryIndex />;
}
