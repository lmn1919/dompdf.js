const path = require('path');

const rootDir = process.cwd();

module.exports = {
  entry: path.resolve(rootDir, 'src/index.ts'),
  output: {
    path: path.resolve(rootDir, 'dist'),
    filename: 'bundle.[contenthash:8].js',
  },
  module: {
    rules: [
      {
        test: /\.(jsx|js)$/,
        use: 'babel-loader',
        include: path.resolve(rootDir, 'src'),
        exclude: /node_modules/,
      },
      { test: /\.tsx?$/, use: ["ts-loader"], exclude: /node_modules/ }
    ]
  },
  plugins: [
    // new HtmlWebpackPlugin({
    //   template: path.resolve(rootDir, 'public/test.ejs'),
    //   inject: 'body',
    //   scriptLoading: 'blocking',
    // }),
    // new CleanWebpackPlugin(),
    // new ClassToStyleWebpackPlugin({outFileName:"buildInfo"})
  ],
}