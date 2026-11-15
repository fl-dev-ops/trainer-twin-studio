import { lazy, Suspense, type ComponentType } from "react";

// The isolated browser harness has no Next runtime. Keep the real lazy component and loading boundary.
export default function dynamic<P extends object>(load: () => Promise<ComponentType<P>>, options: { loading?: ComponentType } = {}) {
  const Component = lazy(async () => ({ default: await load() }));
  const Loading = options.loading;
  return function LazyComponent(props: P) {
    return <Suspense fallback={Loading ? <Loading /> : null}><Component {...props} /></Suspense>;
  };
}
