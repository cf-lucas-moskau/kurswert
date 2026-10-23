// Runs in the page. Supports both the classic SRP (__INITIAL_STATE__) and the
// Next.js search experience mobile.de rolled out to everyone by Oct 2026, where
// listings live in the RSC flight payload (self.__next_f) and titles only in the
// rendered card props. New-experience listings are mapped to the classic shape
// so everything downstream (features, train, labels) keeps working unchanged.
const extractSrp = () => {
  const d = window.__INITIAL_STATE__?.search?.srp?.data;
  if (d?.searchResults) return { searchResults: d.searchResults, aggregations: d.aggregations };
  // read the flight chunks from the inline <script> tags, not the self.__next_f
  // array: once Next hydrates it swaps push() for a callback and later chunks
  // never land in the array, so the array is timing-dependent
  const PREFIX = 'self.__next_f.push(';
  const s = [...document.querySelectorAll('script:not([src])')]
    .map((el) => el.textContent)
    .filter((t) => t.startsWith(PREFIX))
    .map((t) => { try { const c = JSON.parse(t.slice(PREFIX.length, t.lastIndexOf(')'))); return typeof c[1] === 'string' ? c[1] : ''; } catch { return ''; } })
    .join('');
  const at = s.indexOf('{"numResultsTotal"');
  if (at < 0) return null;
  let depth = 0, end = at;
  for (; end < s.length; end++) {
    if (s[end] === '{') depth++;
    else if (s[end] === '}' && --depth === 0) break;
  }
  let data;
  try { data = JSON.parse(s.slice(at, end + 1)); } catch { return null; } // payload still streaming
  if (!Array.isArray(data.listings)) return null;
  // titles: each card's props carry listingId, followed by its shortTitle/subTitle
  const titles = {};
  const ids = [...s.matchAll(/"listingId":(\d+)/g)];
  ids.forEach((m, i) => {
    const chunk = s.slice(m.index, ids[i + 1]?.index ?? m.index + 5000);
    const str = (key) => { const t = chunk.match(new RegExp(`"${key}":("(?:[^"\\\\]|\\\\.)*")`)); const v = t && JSON.parse(t[1]); return v && v !== '$undefined' ? v : ''; };
    // a card repeats listingId in several props; keep the occurrence that has the title
    if (str('shortTitle')) titles[m[1]] = { ...titles[m[1]], shortTitle: str('shortTitle'), subTitle: str('subTitle') };
    // card image is a scheme-less path; the rule param picks the rendition size
    const img = chunk.match(/"src":"(img\.classistatic\.de\/[^"?]+)"/);
    if (img && !titles[m[1]]?.image) titles[m[1]] = { ...titles[m[1]], image: `https://${img[1]}?rule=mo-360w` };
  });
  const RATING = { VERY_GOOD_PRICE: 'Sehr guter Preis', GOOD_PRICE: 'Guter Preis', REASONABLE_PRICE: 'Fairer Preis', INCREASED_PRICE: 'Erhöhter Preis', HIGH_PRICE: 'Hoher Preis' };
  const items = data.listings.map((l) => {
    const t = titles[l.id] || {};
    const model = l.model?.localized || null;
    return {
      id: l.id,
      type: l.type,
      attr: l.attr,
      make: l.make?.localized || null,
      model,
      shortTitle: t.shortTitle || [l.make?.localized, model].filter(Boolean).join(' '),
      subTitle: t.subTitle || '',
      previewImage: t.image ? { src: t.image } : null,
      price: { grossAmount: l.price?.grs?.amount ?? null },
      priceRating: { rating: l.priceRating?.rating, ratingLabel: RATING[l.priceRating?.rating] || null },
      contactInfo: { country: l.attr?.cn, sellerType: l.contact?.enumType === 'DEALER' ? 'DEALER' : 'PRIVATE' },
      sellerId: l.sellerId,
    };
  });
  const PER_PAGE = 20; // regular results per page; top/eyecatcher slots are extra
  return {
    searchResults: {
      items,
      numResultsTotal: data.numResultsTotal,
      numPages: Math.min(50, Math.ceil(data.numResultsTotal / PER_PAGE)),
      page: data.pageNumber,
    },
    aggregations: null,
  };
};

module.exports = { extractSrp };
