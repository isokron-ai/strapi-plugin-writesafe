// Stand-ins for @strapi/strapi/admin, @strapi/design-system and react-router-dom, so the admin pages' parts render
// with react-dom/server in a unit test (settings-admin.test.js). Each component renders a <div data-c="Name"> with its
// state props as attributes.
import * as React from 'react';

const h = React.createElement;
const ATTRS = ['disabled', 'checked', 'value', 'name', 'hint'];
const C = (name) => function Stub(props) {
  const a = { 'data-c': name };
  for (const k of ATTRS) if (props[k] !== undefined) a[`data-${k}`] = String(props[k]);
  if (props['data-testid']) a['data-testid'] = props['data-testid'];
  return h('div', a, props.children);
};
export const Box = C('Box'); export const Flex = C('Flex'); export const Typography = C('Typography'); export const Button = C('Button');
export const Badge = C('Badge'); export const Table = C('Table'); export const Thead = C('Thead'); export const Tbody = C('Tbody');
export const Tr = C('Tr'); export const Th = C('Th'); export const Td = C('Td'); export const Toggle = C('Toggle');
export const NumberInput = C('NumberInput'); export const Checkbox = C('Checkbox'); export const Link = C('Link'); export const Loader = C('Loader');
export const Grid = { Root: C('Grid.Root'), Item: C('Grid.Item') };
export const Field = { Root: C('Field.Root'), Label: C('Field.Label'), Hint: C('Field.Hint') };
export const Page = { Main: C('Page.Main'), Title: C('Page.Title'), Protect: C('Page.Protect') };
export const Layouts = { Header: C('Layouts.Header'), Content: C('Layouts.Content') };
export const useFetchClient = () => ({ get: async () => ({}), put: async () => ({}) });
export const useNotification = () => ({ toggleNotification: () => {} });
export const useRBAC = () => ({ allowedActions: { canRead: true, canUpdate: true } });
export const NavLink = C('NavLink');
