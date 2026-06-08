export type SessionNavigationRailItem = {
  id: string
  label: string
  title: string
  status?: string
}

type SessionNavigationRailProps = {
  ariaLabel: string
  items: SessionNavigationRailItem[]
  onSelectItem(itemId: string): void
}

export function SessionNavigationRail(props: SessionNavigationRailProps) {
  if (props.items.length === 0) return null

  return (
    <nav className="session-navigation-rail" aria-label={props.ariaLabel}>
      <div className="session-navigation-rail-line" aria-hidden="true" />
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="session-navigation-anchor"
          data-status={item.status}
          title={item.title}
          aria-label={`跳转到${props.ariaLabel.replace(/导航$/, '')} ${item.label}：${item.title}`}
          onClick={() => props.onSelectItem(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  )
}
