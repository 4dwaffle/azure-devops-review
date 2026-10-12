import path from 'path-browserify';
import picomatch from 'picomatch';
export const posix={...path,matchesGlob:(value,pattern)=>picomatch.isMatch(value,pattern,{dot:true})};
export const {basename,dirname,normalize,join,extname,isAbsolute,relative}=path;
export const resolve=(...paths)=>path.resolve('/',...paths);
export const sep='/';
export default {...posix,resolve,sep};
