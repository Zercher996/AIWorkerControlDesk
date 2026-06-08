type SearchBoxProps = {
  query: string
  onQueryChange(query: string): void
  onSearch(query: string): void
}

export function SearchBox(props: SearchBoxProps) {
  return (
    <form
      className="search-box"
      onSubmit={(event) => {
        event.preventDefault()
        props.onSearch(props.query)
      }}
    >
      <label htmlFor="history-query">搜索历史输出</label>
      <input
        id="history-query"
        name="history-query"
        value={props.query}
        onChange={(event) => props.onQueryChange(event.target.value)}
      />
      <button type="submit">搜索</button>
    </form>
  )
}
