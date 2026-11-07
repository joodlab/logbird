import { getPage } from '../lib/site-map';
export function PlaceholderPage({ path }: { path: string }) {
  const page = getPage(path);
  return (
    <>
      <h1>{page.title === 'Home' ? 'Logbird' : page.title}</h1>
      <p>{page.description}</p>
    </>
  );
}
