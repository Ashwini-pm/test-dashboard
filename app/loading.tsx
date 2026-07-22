// Route-transition loader: any click that navigates shows this instantly,
// so it's always obvious the app is working.
export default function Loading() {
  return (
    <div className="page-loading">
      <span className="spinner" aria-hidden="true" />
      loading data…
    </div>
  );
}
