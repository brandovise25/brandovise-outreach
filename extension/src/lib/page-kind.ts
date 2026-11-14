export type PageKind =
  | 'profile'
  | 'activity'
  | 'feed'
  | 'post'
  | 'search-people'
  | 'search-content'
  | 'connections'
  | 'sent-invitations'
  | 'messaging'
  | 'other';

export function pageKind(pathname: string): PageKind {
  if (/^\/in\/[^/]+\/recent-activity\//.test(pathname)) return 'activity';
  if (/^\/in\/[^/]+\/?$/.test(pathname)) return 'profile';
  if (/^\/feed\/update\//.test(pathname) || /^\/posts\//.test(pathname)) return 'post';
  if (/^\/feed\/?$/.test(pathname)) return 'feed';
  if (/^\/search\/results\/people\//.test(pathname)) return 'search-people';
  if (/^\/search\/results\/content\//.test(pathname)) return 'search-content';
  if (/^\/mynetwork\/invite-connect\/connections\//.test(pathname)) return 'connections';
  if (/^\/mynetwork\/invitation-manager\/sent\//.test(pathname)) return 'sent-invitations';
  if (/^\/messaging\//.test(pathname)) return 'messaging';
  return 'other';
}
