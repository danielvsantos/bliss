import nextra from 'nextra';

const withNextra = nextra({
  contentDirBasePath: '/docs',
  search: {
    codeblocks: false,
  },
});

export default withNextra({
  reactStrictMode: true,
});
