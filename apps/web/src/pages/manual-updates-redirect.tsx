import { Navigate, useLocation } from "react-router-dom";

/** Old Asset Price Updates URL → Manage Assets (#81), keeping the query string. */
export default function ManualUpdatesRedirect() {
  const location = useLocation();
  return <Navigate to={`/assets${location.search}`} replace />;
}
